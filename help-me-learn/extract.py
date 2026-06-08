"""
extract.py — hybrid PDF extraction for Help me Learn (local).

Why hybrid? Research on PDF extraction is unambiguous:
  • Embedded raster images live as XObject streams — pull them from the PDF's own
    structure (here via pdfium page objects). This NEVER misses a photo/screenshot,
    even one with a white background that pixel analysis would skip.
  • Vector diagrams (graphs, trees, boxes) are drawn with path operators, not images,
    so they must be found by LAYOUT ANALYSIS on the rendered page (ink minus text).
  • Coloured TEXT callouts must be classified as TEXT, not captured as figures.

So the pipeline is:
  1. TEXT  — pdf_oxide.to_markdown(page)  (best-in-class reading order & headings)
  2. RASTER regions — pdfium image page-objects' bounding boxes (reliable)
  3. VECTOR regions — render page, build an ink grid, subtract text char-boxes AND
     raster regions, connected-components → diagram regions; drop text-dense blobs
  4. Crop every surviving region from the high-res render → JPEG (base64 data URL)
  5. Pin a [[FIG:fN]] marker into the page text at each figure's vertical position

Output shape is EXACTLY what the existing frontend already consumes:
    { "text", "pages", "truncated", "images": [{id, page, w, h, url}] }
"""

from __future__ import annotations
import base64
import io
import math
import os
import tempfile
from collections import deque

import numpy as np
import pypdfium2 as pdfium
from pypdfium2 import raw as pdfium_c
from PIL import Image

# ---- tunables (safe to adjust) ----
MAX_PAGES = 60
FIG_CAP = 60
RENDER_SCALE = 2.0           # 144 DPI-ish; crisp crops without huge memory
INK_THRESHOLD = 232          # a pixel channel below this counts as "ink" (non-white)
MIN_FIG_FRAC_W = 0.05        # ignore figures narrower than 5% of page width
MIN_FIG_FRAC_H = 0.035       # ...or shorter than 3.5% of page height
TEXTBOX_CHAR_COV = 0.16      # if chars cover >16% of a candidate, it's a text block, not a figure
JPEG_QUALITY = 85
MAX_CROP_DIM = 1500          # downscale crops so data URLs stay small


# ---------------------------------------------------------------------------
# pdf_oxide text extraction (with graceful fallback to pdfium text)
# ---------------------------------------------------------------------------
def _oxide_markdown(path: str, n_pages: int):
    """Return a list of per-page markdown strings using pdf_oxide; [] on failure."""
    try:
        from pdf_oxide import PdfDocument
    except Exception:  # noqa: BLE001
        return []
    try:
        doc = PdfDocument(path)
    except Exception:  # noqa: BLE001
        return []
    pages = []
    for i in range(n_pages):
        txt = ""
        # try the richest API first, then degrade — keeps working across versions
        for attempt in (
            lambda: doc.to_markdown(i, detect_headings=True),
            lambda: doc.to_markdown(i),
            lambda: doc.to_plain_text(i),
            lambda: doc.extract_text(i),
        ):
            try:
                txt = attempt() or ""
                if txt:
                    break
            except Exception:  # noqa: BLE001
                continue
        pages.append(txt.strip())
    return pages


def _pdfium_text(page) -> str:
    try:
        tp = page.get_textpage()
        return (tp.get_text_bounded() or "").strip()
    except Exception:  # noqa: BLE001
        return ""


# ---------------------------------------------------------------------------
# geometry helpers — all boxes are dicts {x0,y0,x1,y1,kind} in TOP-DOWN points
# ---------------------------------------------------------------------------
def _overlap_frac(a, b):
    ix = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
    iy = min(a["y1"], b["y1"]) - max(a["y0"], b["y0"])
    inter = max(0.0, ix) * max(0.0, iy)
    area = max(1.0, (a["x1"] - a["x0"]) * (a["y1"] - a["y0"]))
    return inter / area


def _merge_boxes(boxes, tol):
    out = []
    for f in sorted(boxes, key=lambda b: (b["y0"], b["x0"])):
        hit = None
        for g in out:
            if not (f["x1"] < g["x0"] - tol or f["x0"] > g["x1"] + tol
                    or f["y1"] < g["y0"] - tol or f["y0"] > g["y1"] + tol):
                hit = g
                break
        if hit:
            hit["x0"] = min(hit["x0"], f["x0"]); hit["y0"] = min(hit["y0"], f["y0"])
            hit["x1"] = max(hit["x1"], f["x1"]); hit["y1"] = max(hit["y1"], f["y1"])
            if f.get("kind") == "raster":
                hit["kind"] = "raster"
        else:
            out.append(dict(f))
    return out


# ---------------------------------------------------------------------------
# per-page geometry from pdfium: char boxes (text) + image-object boxes (raster)
# ---------------------------------------------------------------------------
def _char_boxes(page, page_h):
    """All glyph bounding boxes, converted to top-down points."""
    boxes = []
    try:
        tp = page.get_textpage()
        n = tp.count_chars()
        for idx in range(n):
            try:
                l, b, r, t = tp.get_charbox(idx)  # page space, y-up
            except Exception:  # noqa: BLE001
                continue
            if r <= l or t <= b:
                continue
            boxes.append({"x0": l, "y0": page_h - t, "x1": r, "y1": page_h - b})
    except Exception:  # noqa: BLE001
        pass
    return boxes


def _raster_boxes(page, page_w, page_h):
    """Bounding boxes of embedded raster images (recurses into form XObjects)."""
    boxes = []
    try:
        objs = page.get_objects(
            filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,),
            max_depth=4,
        )
    except Exception:  # noqa: BLE001
        objs = []
    for obj in objs:
        try:
            l, b, r, t = obj.get_pos()  # page space, y-up
        except Exception:  # noqa: BLE001
            continue
        x0, x1 = min(l, r), max(l, r)
        y0, y1 = page_h - max(t, b), page_h - min(t, b)
        w, h = x1 - x0, y1 - y0
        if w < page_w * 0.045 or h < page_h * 0.035:
            continue                                  # tiny icon / bullet / logo
        if w * h > page_w * page_h * 0.97:
            continue                                  # full-page background
        boxes.append({"x0": max(0, x0), "y0": max(0, y0),
                      "x1": min(page_w, x1), "y1": min(page_h, y1), "kind": "raster"})
    return _merge_boxes(boxes, max(8.0, page_w * 0.01))


# ---------------------------------------------------------------------------
# vector-diagram detection: ink layout analysis on the rendered page
# ---------------------------------------------------------------------------
def _ink_grid(arr, cell):
    """arr: HxWx3 uint8. Returns boolean grid where a cell holds ≥2 ink pixels."""
    H, W = arr.shape[:2]
    ink = (arr < INK_THRESHOLD).any(axis=2)            # HxW bool
    gH, gW = math.ceil(H / cell), math.ceil(W / cell)
    pad = np.zeros((gH * cell, gW * cell), dtype=np.int32)
    pad[:H, :W] = ink.astype(np.int32)
    block = pad.reshape(gH, cell, gW, cell).sum(axis=(1, 3))
    return block >= 2


def _clear_cells(grid, box, cell, scale):
    """Zero out grid cells covered by a (top-down points) box."""
    gH, gW = grid.shape
    gx0 = max(0, int(box["x0"] * scale // cell)); gx1 = min(gW - 1, int(box["x1"] * scale // cell))
    gy0 = max(0, int(box["y0"] * scale // cell)); gy1 = min(gH - 1, int(box["y1"] * scale // cell))
    if gx1 >= gx0 and gy1 >= gy0:
        grid[gy0:gy1 + 1, gx0:gx1 + 1] = False


def _dilate(grid):
    out = grid.copy()
    out[:-1, :] |= grid[1:, :]; out[1:, :] |= grid[:-1, :]
    out[:, :-1] |= grid[:, 1:]; out[:, 1:] |= grid[:, :-1]
    return out


def _components(grid):
    """4/8-connected components → list of (minx,miny,maxx,maxy,area) in grid cells."""
    gH, gW = grid.shape
    seen = np.zeros_like(grid, dtype=bool)
    comps = []
    for sy in range(gH):
        for sx in range(gW):
            if not grid[sy, sx] or seen[sy, sx]:
                continue
            minx = maxx = sx; miny = maxy = sy; area = 0
            q = deque([(sy, sx)]); seen[sy, sx] = True
            while q:
                cy, cx = q.popleft(); area += 1
                if cx < minx: minx = cx
                if cx > maxx: maxx = cx
                if cy < miny: miny = cy
                if cy > maxy: maxy = cy
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < gH and 0 <= nx < gW and grid[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True; q.append((ny, nx))
            comps.append((minx, miny, maxx, maxy, area))
    return comps


def _char_coverage(box, char_boxes):
    """Fraction of a box's area covered by glyphs (high ⇒ it's a text block)."""
    area = max(1.0, (box["x1"] - box["x0"]) * (box["y1"] - box["y0"]))
    cov = 0.0
    for c in char_boxes:
        ix = min(c["x1"], box["x1"]) - max(c["x0"], box["x0"])
        iy = min(c["y1"], box["y1"]) - max(c["y0"], box["y0"])
        if ix > 0 and iy > 0:
            cov += ix * iy
    return cov / area


def _detect_vector(arr, char_boxes, raster_boxes, page_w, page_h, med_h_pt):
    scale = RENDER_SCALE
    cell = max(5, int(round(med_h_pt * scale * 0.45)))
    grid = _ink_grid(arr, cell)
    for cb in char_boxes:                 # subtract selectable text
        _clear_cells(grid, cb, cell, scale)
    for rb in raster_boxes:               # subtract already-known images
        _clear_cells(grid, rb, cell, scale)
    grid = _dilate(grid)                  # bridge dashed strokes / sparse diagrams
    figs = []
    for (minx, miny, maxx, maxy, area) in _components(grid):
        x0 = minx * cell / scale; y0 = miny * cell / scale
        x1 = (maxx + 1) * cell / scale; y1 = (maxy + 1) * cell / scale
        w, h = x1 - x0, y1 - y0
        if w < page_w * MIN_FIG_FRAC_W or h < page_h * MIN_FIG_FRAC_H:
            continue
        if area < 6:
            continue
        if w * h > page_w * page_h * 0.9:
            continue
        box = {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "kind": "vector"}
        if _char_coverage(box, char_boxes) > TEXTBOX_CHAR_COV:
            continue                      # coloured TEXT callout / header bar → keep as text
        figs.append(box)
    return _merge_boxes(figs, 10.0)


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------
def _data_url_from_crop(arr, box, scale):
    H, W = arr.shape[:2]
    mx = max(W / scale * 0.012, 5)
    x0 = max(0, int((box["x0"] - mx) * scale)); y0 = max(0, int((box["y0"] - mx) * scale))
    x1 = min(W, int((box["x1"] + mx) * scale)); y1 = min(H, int((box["y1"] + mx) * scale))
    if x1 - x0 < 70 or y1 - y0 < 60:
        return None, 0, 0
    crop = arr[y0:y1, x0:x1]
    img = Image.fromarray(crop)
    m = max(img.width, img.height)
    if m > MAX_CROP_DIM:
        s = MAX_CROP_DIM / m
        img = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}", img.width, img.height


def _inject_markers(text: str, figs_on_page, page_h: float) -> str:
    """Insert [[FIG:fN]] lines into page markdown at each figure's vertical position."""
    if not figs_on_page:
        return text
    lines = text.split("\n") if text else []
    if not lines:
        return "\n\n".join(f"[[FIG:{f['id']}]]" for f in figs_on_page)
    n = len(lines)
    placed = sorted(figs_on_page, key=lambda f: (f["y0"] + f["y1"]) / 2)
    inserts = {}
    used = set()
    for f in placed:
        yc = (f["y0"] + f["y1"]) / 2
        idx = min(n, max(0, round((yc / max(1.0, page_h)) * n)))
        while idx in used:
            idx += 1
            if idx > n:
                idx = n
                break
        used.add(idx)
        inserts.setdefault(idx, []).append(f["id"])
    out = []
    for i in range(n + 1):
        for fid in inserts.get(i, []):
            out.append(f"[[FIG:{fid}]]")
        if i < n:
            out.append(lines[i])
    return "\n".join(out)


def extract_pdf(pdf_bytes: bytes, progress=None):
    """Hybrid extraction. `progress(msg)` is an optional status callback."""
    # pdf_oxide wants a path; write the upload to a temp file
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp.write(pdf_bytes); tmp.flush(); tmp.close()
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        total = len(pdf)
        n_pages = min(total, MAX_PAGES)
        oxide_pages = _oxide_markdown(tmp.name, n_pages)

        images = []
        parts = []
        fig_seq = 1
        for i in range(n_pages):
            if progress:
                progress(f"Analyse de la page {i + 1}/{n_pages}…")
            page = pdf[i]
            page_w, page_h = page.get_size()

            # text: pdf_oxide first, pdfium as a safety net (never lose the text)
            text = oxide_pages[i] if i < len(oxide_pages) else ""
            if not text:
                text = _pdfium_text(page)

            page_figs = []
            if len(images) < FIG_CAP:
                char_boxes = _char_boxes(page, page_h)
                heights = sorted((c["y1"] - c["y0"]) for c in char_boxes if c["y1"] > c["y0"])
                med_h = heights[len(heights) // 2] if heights else 10.0

                raster = _raster_boxes(page, page_w, page_h)

                # render once, reuse for vector detection AND cropping
                try:
                    pil = page.render(scale=RENDER_SCALE).to_pil().convert("RGB")
                    arr = np.asarray(pil)
                except Exception:  # noqa: BLE001
                    arr = None

                vector = []
                if arr is not None:
                    vector = _detect_vector(arr, char_boxes, raster, page_w, page_h, med_h)

                # combine: every raster region + vector regions not already covered
                combined = list(raster)
                for v in vector:
                    if any(_overlap_frac(v, r) > 0.55 or _overlap_frac(r, v) > 0.6 for r in raster):
                        continue
                    combined.append(v)
                combined = _merge_boxes(combined, 12.0)

                if arr is not None:
                    for g in sorted(combined, key=lambda b: (b["y0"], b["x0"])):
                        if len(images) >= FIG_CAP:
                            break
                        url, w, h = _data_url_from_crop(arr, g, RENDER_SCALE)
                        if not url:
                            continue
                        fid = f"f{fig_seq}"; fig_seq += 1
                        rec = {"id": fid, "page": i + 1, "w": w, "h": h, "url": url}
                        images.append(rec)
                        page_figs.append({**g, "id": fid})

            parts.append(_inject_markers(text, page_figs, page_h))

        return {
            "text": "\n\n".join(p for p in parts if p).strip(),
            "pages": total,
            "truncated": total > n_pages,
            "images": images,
        }
    finally:
        try:
            pdf.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            os.unlink(tmp.name)
        except Exception:  # noqa: BLE001
            pass
