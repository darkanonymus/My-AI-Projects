/* ============================================================
   pdf-extraction.jsx — PDF figure/image extraction
   Layout-aware extraction that reproduces the course's reading
   order (real lines, paragraphs, headings, columns) and detects
   figures — both raster images (via the PDF's draw commands) and
   vector diagrams (via ink-density layout analysis) — pinning
   each one in place with a [[FIG:fN]] marker so the AI re-inserts
   the true image exactly where it appears in the source.
   extractFromPDF / extractFromImage are the public entry points
   (local-backend hybrid extraction + Tesseract OCR fallback).
   ============================================================ */

/* ============================================================
   FILE EXTRACTION
   ============================================================ */
/* ---- ORIGINAL IMAGE EXTRACTION from a PDF (best-effort, never blocks text) ---- */
window.FIG_SEQ = window.FIG_SEQ || 1;

function _downscale(canvas, maxDim) {
  const w = canvas.width, h = canvas.height, m = Math.max(w, h);
  if (m <= maxDim) return canvas;
  const s = maxDim / m, c2 = document.createElement("canvas");
  c2.width = Math.round(w * s); c2.height = Math.round(h * s);
  c2.getContext("2d").drawImage(canvas, 0, 0, c2.width, c2.height);
  return c2;
}

/* ============================================================
   LAYOUT-AWARE PDF EXTRACTION  (faithful reading order)
   Goal: reproduce the COURSE TEXT exactly — real lines, paragraphs,
   headings, de-hyphenation, 2-column handling — instead of one flat
   blob. Figures (incl. VECTOR diagrams) are captured by rendering the
   page region they occupy, and pinned in place with a [[FIG:fN]] marker
   inserted at their reading position, so the AI re-inserts the true
   image exactly where it appears in the course.
   ============================================================ */

/* one page → ordered text lines with positions + font height */
async function _pageLines(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const raw = [];
  for (const it of tc.items) {
    if (!it.str || !it.transform) continue;
    const t = it.transform;
    const x = t[4];
    const yTop = vp.height - t[5];                       // baseline, top-down
    const fh = Math.hypot(t[2], t[3]) || it.height || 10;
    const w = it.width || (it.str.length * fh * 0.5);
    if (!it.str.trim() && w < fh) continue;              // drop stray spaces
    raw.push({ str: it.str, x, y: yTop, fh, w });
  }
  raw.sort((a, b) => a.y - b.y || a.x - b.x);
  // cluster fragments into lines by baseline proximity
  const lines = [];
  for (const it of raw) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(it.y - L.y) <= Math.max(2.5, it.fh * 0.55)) {
      L.items.push(it); L.y = (L.y * L.n + it.y) / (L.n + 1); L.n++;
    } else {
      lines.push({ y: it.y, n: 1, items: [it] });
    }
  }
  // build each line's text + bbox + dominant font height
  lines.forEach(L => {
    L.items.sort((a, b) => a.x - b.x);
    let text = "", prevEnd = null, fh = 0, x0 = Infinity, x1 = -Infinity;
    L.items.forEach(it => {
      fh = Math.max(fh, it.fh);
      x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x + it.w);
      if (prevEnd != null && text && !/\s$/.test(text)) {
        if (it.x - prevEnd > it.fh * 0.28) text += " ";
      }
      text += it.str;
      prevEnd = it.x + it.w;
    });
    L.text = text.replace(/[ \t]+/g, " ").trim();
    L.fh = fh; L.x0 = x0; L.x1 = x1;
  });
  return { lines: lines.filter(L => L.text), height: vp.height, width: vp.width };
}

/* detect a 2-column layout; return [linesAll] or [left, right] */
function _splitColumns(lines, W) {
  const body = lines.filter(l => !l._fig && !l._consumed);
  if (body.length < 8) return [lines];
  const cL = W * 0.46, cR = W * 0.54;
  let crossing = 0;
  body.forEach(L => { if (L.x0 < cL && L.x1 > cR) crossing++; });
  const left = lines.filter(L => L.x1 <= W * 0.54);
  const right = lines.filter(L => L.x0 >= W * 0.46);
  if (crossing / body.length < 0.1 && left.length >= 4 && right.length >= 4 &&
      (left.length + right.length) >= lines.length * 0.85) {
    return [left, right];
  }
  return [lines];
}

/* Is this line normal running prose (vs. a scattered diagram label)?
   Prose = good horizontal coverage AND a real word-count, not isolated tokens. */
function _isProse(L) {
  const wsum = L.items ? L.items.reduce((s, it) => s + (it.w || 0), 0) : (L.x1 - L.x0);
  const span = Math.max(1, L.x1 - L.x0);
  const coverage = wsum / span;                 // diagrams: tokens with big gaps → low
  const nchar = L.text.replace(/\s/g, "").length;
  const words = L.text.trim().split(/\s+/).length;
  return coverage >= 0.5 && nchar >= 14 && words >= 3;
}

/* ---- INK-BASED FIGURE DETECTION (layout analysis on the RENDERED page) ----
   Crops follow the figure's actual INK (vector strokes + raster pixels),
   not the selectable text boxes — so nothing gets clipped. Pipeline:
   1) render page → ink grid (cells with non-white pixels)
   2) subtract the text layer → leaves non-text ink (drawings, screenshots)
   3) dilate + connected components → one box per figure
   4) grow each box to swallow its own labels/captions (the absorbed lines
      are removed from the course text). Returns page-coord boxes. */
function _detectFigures(canvas, lines, scale, pageW, pageH, medFh) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  let img; try { img = ctx.getImageData(0, 0, W, H).data; } catch (e) { return []; }
  const cell = Math.max(5, Math.round(medFh * scale * 0.45));
  const gW = Math.ceil(W / cell), gH = Math.ceil(H / cell);
  const ink = new Uint8Array(gW * gH);

  // 1) ink grid
  for (let gy = 0; gy < gH; gy++) {
    for (let gx = 0; gx < gW; gx++) {
      const x0 = gx * cell, y0 = gy * cell, x1 = Math.min(W, x0 + cell), y1 = Math.min(H, y0 + cell);
      let cnt = 0;
      for (let py = y0; py < y1 && cnt < 2; py += 2) {
        const row = py * W * 4;
        for (let px = x0; px < x1; px += 2) {
          const i = row + px * 4;
          if (img[i + 3] > 16 && (img[i] < 232 || img[i + 1] < 232 || img[i + 2] < 232)) { if (++cnt >= 2) break; }
        }
      }
      if (cnt >= 2) ink[gy * gW + gx] = 1;
    }
  }
  // 2) subtract text-layer boxes (selectable text is NOT a figure)
  for (const L of lines) {
    if (L._fig) continue;
    const bx0 = Math.floor(L.x0 * scale / cell), bx1 = Math.ceil(L.x1 * scale / cell);
    const by0 = Math.floor((L.y - L.fh) * scale / cell), by1 = Math.ceil((L.y + L.fh * 0.35) * scale / cell);
    for (let gy = Math.max(0, by0); gy <= Math.min(gH - 1, by1); gy++)
      for (let gx = Math.max(0, bx0); gx <= Math.min(gW - 1, bx1); gx++)
        ink[gy * gW + gx] = 0;
  }
  // 3) dilate (bridge dashed strokes / sparse diagrams) then label components
  const dil = ink.slice();
  for (let gy = 0; gy < gH; gy++) for (let gx = 0; gx < gW; gx++) {
    if (!ink[gy * gW + gx]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ny = gy + dy, nx = gx + dx;
      if (ny >= 0 && ny < gH && nx >= 0 && nx < gW) dil[ny * gW + nx] = 1;
    }
  }
  const seen = new Uint8Array(gW * gH), comps = [], stack = [];
  for (let s = 0; s < gW * gH; s++) {
    if (!dil[s] || seen[s]) continue;
    let minx = gW, miny = gH, maxx = 0, maxy = 0, area = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const c = stack.pop(), cy = (c / gW) | 0, cx = c % gW;
      area++; if (cx < minx) minx = cx; if (cx > maxx) maxx = cx; if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ny = cy + dy, nx = cx + dx;
        if (ny < 0 || ny >= gH || nx < 0 || nx >= gW) continue;
        const ni = ny * gW + nx;
        if (dil[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    comps.push({ minx, miny, maxx, maxy, area });
  }
  // 4) component grids → page-coord boxes, filter noise / rules / full-page
  let figs = comps.map(c => ({
    x0: c.minx * cell / scale, y0: c.miny * cell / scale,
    x1: (c.maxx + 1) * cell / scale, y1: (c.maxy + 1) * cell / scale, area: c.area
  })).filter(f => {
    const w = f.x1 - f.x0, h = f.y1 - f.y0;
    if (w * scale < 46 || h * scale < 46) return false;          // too small (icons, bullets)
    if (f.area < 6) return false;                                 // sparse noise
    if (w * h > pageW * pageH * 0.9) return false;                // ~full page scan → leave to text
    return true;
  });
  // 5) tag as vector-drawn regions and merge overlapping/adjacent boxes.
  //    Label/caption absorption is done later, once, on the COMBINED set
  //    (raster + vector) by _absorbLabels — so it runs uniformly.
  figs.forEach(f => { f.kind = "vector"; });
  return _mergeBoxes(figs, 10);
}

/* assemble ordered lines into clean markdown-ish text */
function _assemble(lines) {
  const real = lines.filter(l => l.text && !l._consumed);
  if (!real.length) return "";
  const fhs = real.filter(l => !l._fig).map(l => l.fh).filter(Boolean).sort((a, b) => a - b);
  const med = fhs.length ? fhs[Math.floor(fhs.length / 2)] : 10;
  const ordered = real.slice().sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const blocks = []; let buf = "", prev = null;
  const flush = () => { if (buf.trim()) blocks.push(buf.trim()); buf = ""; };
  for (const L of ordered) {
    if (L._fig) { flush(); blocks.push(L.text); prev = L; continue; }
    const heading = L.fh >= med * 1.34 && L.text.length <= 72 && !/[.,;:]$/.test(L.text);
    if (prev && !prev._fig) { const gap = L.y - prev.y; if (gap > med * 2.0 || heading) flush(); }
    if (heading) { flush(); blocks.push("#### " + L.text); prev = L; continue; }
    if (buf) {
      if (/[\-\u00ad]$/.test(buf) && /^[a-zàâäéèêëîïôöùûüçß]/.test(L.text)) buf = buf.replace(/[\-\u00ad]$/, "") + L.text;
      else buf += " " + L.text;
    } else buf = L.text;
    prev = L;
  }
  flush();
  return blocks.join("\n\n");
}

async function _renderPage(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}
/* fraction of non-white pixels in a region (sampled) — detects real ink vs blank */
function _inkRatio(ctx, x, y, w, h) {
  try {
    const data = ctx.getImageData(x, y, w, h).data;
    let ink = 0, n = 0;
    for (let py = 0; py < h; py += 3) for (let px = 0; px < w; px += 3) {
      const i = (py * w + px) * 4, a = data[i + 3];
      n++;
      if (a > 12 && (data[i] < 236 || data[i + 1] < 236 || data[i + 2] < 236)) ink++;
    }
    return n ? ink / n : 0;
  } catch (e) { return 0; }
}

/* ---- geometry helpers shared by raster + vector figure passes ---- */
/* 2×3 affine matrix multiply (PDF [a b c d e f] convention) */
function _mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
/* fraction of box A's area that lies inside box B */
function _overlapFrac(a, b) {
  const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const inter = Math.max(0, ix) * Math.max(0, iy);
  return inter / Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
}
/* union overlapping / adjacent boxes (tol in page units); 'raster' kind wins */
function _mergeBoxes(boxes, tol) {
  const arr = boxes.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const merged = [];
  for (const f of arr) {
    const m = merged.find(g => !(f.x1 < g.x0 - tol || f.x0 > g.x1 + tol || f.y1 < g.y0 - tol || f.y0 > g.y1 + tol));
    if (m) {
      m.x0 = Math.min(m.x0, f.x0); m.y0 = Math.min(m.y0, f.y0);
      m.x1 = Math.max(m.x1, f.x1); m.y1 = Math.max(m.y1, f.y1);
      if (f.kind === "raster") m.kind = "raster";
    } else merged.push(Object.assign({}, f));
  }
  return merged;
}
/* fraction of a box's area covered by genuine running-prose text lines.
   High → it's a styled TEXT block (coloured callout, header bar), NOT a figure. */
function _proseCoverage(box, lines) {
  let textArea = 0;
  const boxArea = Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0));
  for (const L of lines) {
    if (L._fig || !_isProse(L)) continue;
    const ly0 = L.y - L.fh, ly1 = L.y + L.fh * 0.35;
    const ix = Math.min(L.x1, box.x1) - Math.max(L.x0, box.x0);
    const iy = Math.min(ly1, box.y1) - Math.max(ly0, box.y0);
    if (ix > 0 && iy > 0) textArea += ix * iy;
  }
  return textArea / boxArea;
}
/* grow each figure box to swallow its OWN scattered labels / short captions,
   marking those lines _consumed so they leave the running course text.
   Real prose paragraphs (sentences) are kept OUT — they stay in the text. */
function _absorbLabels(figs, lines, pageW, pageH, medFh) {
  const tol = Math.max(6, medFh * 0.85);
  const used = new Set();
  for (const f of figs) {
    let changed = true, guard = 0;
    while (changed && guard++ < 8) {
      changed = false;
      for (const L of lines) {
        if (L._fig || L._consumed || used.has(L)) continue;
        const lx0 = L.x0, lx1 = L.x1, ly0 = L.y - L.fh, ly1 = L.y + L.fh * 0.35;
        if (lx1 < f.x0 - tol || lx0 > f.x1 + tol || ly1 < f.y0 - tol || ly0 > f.y1 + tol) continue;
        const ix = Math.min(lx1, f.x1) - Math.max(lx0, f.x0), iy = Math.min(ly1, f.y1) - Math.max(ly0, f.y0);
        const frac = (Math.max(0, ix) * Math.max(0, iy)) / Math.max(1, (lx1 - lx0) * (ly1 - ly0));
        // absorb only if the line sits mostly INSIDE the figure, or is a
        // scattered diagram label (not prose). Never eat a real paragraph.
        if (!(frac > 0.55 || (!_isProse(L) && frac > 0.2))) continue;
        const nx0 = Math.min(f.x0, lx0), ny0 = Math.min(f.y0, ly0), nx1 = Math.max(f.x1, lx1), ny1 = Math.max(f.y1, ly1);
        if ((nx1 - nx0) * (ny1 - ny0) > pageW * pageH * 0.92) continue;
        f.x0 = nx0; f.y0 = ny0; f.x1 = nx1; f.y1 = ny1;
        used.add(L); L._consumed = true; changed = true;
      }
    }
  }
}

/* ---- RASTER IMAGE REGIONS via the PDF's own draw commands (most reliable) ----
   PDFs reference embedded photos/screenshots/scans as image XObjects (and
   inline images) in each page's content stream. We walk page.getOperatorList(),
   track the current transformation matrix through save/restore/transform and
   form-XObject wrappers, and for every image-paint opcode compute the on-page
   bounding box (the unit square [0,1]² mapped by the CTM). This NEVER misses an
   embedded raster — even one with a light/white background that ink analysis
   would skip — which is the main reason figures were being lost before. */
async function _imageRegions(page, pageW, pageH) {
  const OPS = window.pdfjsLib && window.pdfjsLib.OPS;
  if (!OPS) return [];
  let opList;
  try { opList = await page.getOperatorList(); } catch (e) { return []; }
  const fns = opList.fnArray, args = opList.argsArray;
  const imgOps = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat].filter(v => v != null));
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const boxes = [];
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    if (fn === OPS.save) { stack.push(ctm.slice()); }
    else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.transform) { const a = args[i]; if (a) ctm = _mul(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]); }
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); const a = args[i]; if (a && a[0]) ctm = _mul(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
    else if (imgOps.has(fn)) {
      // image occupies the unit square [0,1]² mapped through the CTM
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => [
        p[0] * ctm[0] + p[1] * ctm[2] + ctm[4],
        p[0] * ctm[1] + p[1] * ctm[3] + ctm[5],
      ]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
      const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      // PDF user space is y-up; convert to the top-down convention used elsewhere
      const x0 = minX, x1 = maxX, y0 = pageH - maxY, y1 = pageH - minY;
      const w = x1 - x0, h = y1 - y0;
      if (w < pageW * 0.045 || h < pageH * 0.035) continue;        // tiny icon / bullet / logo
      if (w * h > pageW * pageH * 0.97) continue;                   // full-page background scan
      boxes.push({ x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(pageW, x1), y1: Math.min(pageH, y1), kind: "raster" });
    }
  }
  // merge images painted in adjacent tiles / repeated pieces into one region
  return _mergeBoxes(boxes, Math.max(8, pageW * 0.01));
}

/* process one page: faithful text + HYBRID figure capture + inline [[FIG]] markers.
   Pass A — raster image regions from the operator list (never misses a photo).
   Pass B — vector/drawn-diagram regions from ink layout analysis.
   Then: drop regions that are really coloured TEXT boxes, merge, absorb captions,
   and crop each surviving region from the high-res render. */
async function _extractPage(page, pageNum, images, cap) {
  const { lines, width, height } = await _pageLines(page);
  const fhs = lines.map(l => l.fh).filter(Boolean).sort((a, b) => a - b);
  const medFh = fhs.length ? fhs[Math.floor(fhs.length / 2)] : 10;

  if (images.length < cap) {
    // (A) reliable raster-image regions straight from the PDF draw commands
    let rasterBoxes = [];
    try { rasterBoxes = await _imageRegions(page, width, height); } catch (e) { rasterBoxes = []; }

    const scale = 2.0;
    let canvas, ctx;
    try { canvas = await _renderPage(page, scale); ctx = canvas.getContext("2d", { willReadFrequently: true }); } catch (e) { canvas = null; }

    if (canvas) {
      // (B) vector / drawn-diagram regions from ink layout analysis
      const vectorBoxes = _detectFigures(canvas, lines, scale, width, height, medFh);

      // (C) combine. Keep every raster region. Add a vector region only if it is
      //     NOT already covered by a raster one (avoid capturing the same figure
      //     twice) AND it is not actually a coloured TEXT callout / header bar.
      const combined = rasterBoxes.slice();
      for (const v of vectorBoxes) {
        const coveredByRaster = rasterBoxes.some(r => _overlapFrac(v, r) > 0.55 || _overlapFrac(r, v) > 0.6);
        if (coveredByRaster) continue;
        if (_proseCoverage(v, lines) > 0.22) continue;             // styled text block → keep as text, not a figure
        combined.push(v);
      }
      const figs = _mergeBoxes(combined, 12);

      // (D) grow each surviving region to swallow its own caption / labels
      _absorbLabels(figs, lines, width, height, medFh);

      // (E) crop each region from the high-res render, pin a [[FIG]] marker in place
      figs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      const mx = Math.max(width * 0.012, 5);                        // small breathing margin
      for (const g of figs) {
        if (images.length >= cap) break;
        const rx0 = Math.max(0, g.x0 - mx), ry0 = Math.max(0, g.y0 - mx);
        const rx1 = Math.min(width, g.x1 + mx), ry1 = Math.min(height, g.y1 + mx);
        const X = Math.round(rx0 * scale), Y = Math.round(ry0 * scale);
        const W = Math.round((rx1 - rx0) * scale), H = Math.round((ry1 - ry0) * scale);
        if (W < 70 || H < 60) continue;
        // raster regions are trusted even when light; vector regions must hold real ink
        if (g.kind !== "raster" && _inkRatio(ctx, X, Y, W, H) < 0.004) continue;
        const c2 = document.createElement("canvas"); c2.width = W; c2.height = H;
        c2.getContext("2d").drawImage(canvas, X, Y, W, H, 0, 0, W, H);
        const small = _downscale(c2, 1500);
        let url; try { url = small.toDataURL("image/jpeg", 0.85); } catch (e) { continue; }
        if (!url || url.length > 620000) continue;
        const id = "f" + (window.FIG_SEQ++);
        images.push({ id, page: pageNum, w: small.width, h: small.height, url });
        lines.push({ y: (g.y0 + g.y1) / 2, x0: rx0, x1: rx1, fh: medFh, text: "[[FIG:" + id + "]]", _fig: true });
      }
    }
  }

  const cols = _splitColumns(lines, width);
  return cols.map(col => _assemble(col)).filter(Boolean).join("\n\n");
}

/* ---- LOCAL BACKEND extraction (pdf_oxide + pypdfium2 hybrid) ----
   The browser no longer parses the PDF: it hands the file to the local server,
   which runs the high-fidelity hybrid extractor and returns the SAME shape the
   rest of the app already expects: { text, pages, truncated, images:[{id,page,w,h,url}] }.
   The text contains [[FIG:fN]] markers pinned at each figure's reading position. */
async function extractFromPDF(file, onProgress) {
  if (onProgress) onProgress("Extraction haute-fidélité (pdf_oxide)…");
  const fd = new FormData();
  fd.append("file", file, file.name || "document.pdf");
  let resp;
  try {
    resp = await fetch("/api/extract", { method: "POST", body: fd });
  } catch (e) {
    throw new Error("Le serveur local ne répond pas. Lance « python server.py » puis ouvre http://localhost:8000.");
  }
  if (!resp.ok) {
    let msg = "Extraction impossible (" + resp.status + ").";
    try { const j = await resp.json(); if (j && j.detail) msg = j.detail; } catch (_) {}
    throw new Error(msg);
  }
  const data = await resp.json();
  return {
    text: (data.text || "").trim(),
    pages: data.pages || 0,
    truncated: !!data.truncated,
    images: Array.isArray(data.images) ? data.images : [],
  };
}

async function extractFromImage(file, onProgress) {
  if (!window.Tesseract) throw new Error("OCR indisponible.");
  if (onProgress) onProgress("OCR de l'image (allemand + français)…");
  const { data } = await window.Tesseract.recognize(file, "deu+fra", {
    logger: m => {
      if (m.status === "recognizing text" && onProgress)
        onProgress(`OCR en cours — ${Math.round(m.progress * 100)}%`);
    },
  });
  return { text: (data.text || "").trim() };
}

