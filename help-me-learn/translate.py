"""
translate.py — offline course translation via Argos Translate.

Why offline (not the LLM): courses are large and re-translated per language;
an API would be costly. Argos (https://github.com/argosopentech/argos-translate)
runs locally, free, like Piper (TTS) and Whisper (STT). Language packs download
once; Argos pivots through English when there's no direct pair (fr→en→de).

Structure preservation is the whole game: we NEVER send to the translator the
things that must stay intact — LaTeX math, code, ```fig``` diagram blocks,
<<German terms>> (the learning target), and [[C]]…[[/C]] markers. Only prose
text is translated; markdown bullets/headings are kept and only their text is
translated. Worst case the translation is rough — the original course is never
modified (translations are a cached overlay), so the user can switch back.
"""
from __future__ import annotations

import re
import threading

_lock = threading.Lock()
_argos_err: str | None = None
_index_loaded = False
_installed_pairs: set[tuple[str, str]] = set()

# block-level: fenced ```fig```/code blocks are kept verbatim
_FENCE = re.compile(r"```.*?```", re.S)
# inline spans kept verbatim (math, code, German terms, addition markers)
_INLINE = re.compile(
    r"`[^`\n]*`"
    r"|\$\$.*?\$\$"
    r"|\$[^$\n]+\$"
    r"|\\\((?:.|\n)*?\\\)"
    r"|\\\[(?:.|\n)*?\\\]"
    r"|<<[^>]*>>"
    r"|\[\[/?C\]\]",
    re.S,
)
# leading markdown marker on a line (bullet / number / heading / quote)
_PREFIX = re.compile(r"^(\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+)?(.*)$", re.S)


def _mods():
    global _argos_err
    try:
        import argostranslate.package as pkg
        import argostranslate.translate as tr
        return pkg, tr
    except Exception as e:  # noqa: BLE001
        _argos_err = f"{type(e).__name__}: {e}"
        return None, None


def available() -> bool:
    pkg, _ = _mods()
    return bool(pkg)


def status() -> dict:
    return {
        "available": available(),
        "engine": "argos",
        "error": _argos_err,
        "installed_pairs": sorted("/".join(p) for p in _installed_pairs),
    }


def _find(pkg, avail, frm, to):
    return next((p for p in avail if p.from_code == frm and p.to_code == to), None)


def _ensure(frm: str, to: str) -> None:
    """Install the package(s) for frm→to (direct, else via English), once."""
    global _index_loaded
    if frm == to or (frm, to) in _installed_pairs:
        return
    pkg, _ = _mods()
    if not pkg:
        raise RuntimeError(f"Argos indisponible ({_argos_err}). Lance : pip install argostranslate")
    with _lock:
        if (frm, to) in _installed_pairs:
            return
        try:
            installed = {(p.from_code, p.to_code) for p in pkg.get_installed_packages()}
        except Exception:  # noqa: BLE001
            installed = set()
        if (frm, to) in installed or ((frm, "en") in installed and ("en", to) in installed):
            _installed_pairs.add((frm, to))
            return
        if not _index_loaded:
            pkg.update_package_index()
            _index_loaded = True
        avail = pkg.get_available_packages()
        direct = _find(pkg, avail, frm, to)
        legs = [direct] if direct else [_find(pkg, avail, frm, "en"), _find(pkg, avail, "en", to)]
        if not all(legs):
            raise RuntimeError(f"Aucun paquet de traduction {frm}→{to} disponible.")
        for p in legs:
            if (p.from_code, p.to_code) not in installed:
                pkg.install_from_path(p.download())
        _installed_pairs.add((frm, to))


def _tr_block(block: str, frm: str, to: str, tr) -> str:
    """Translate a block FAST: one Argos call for the whole block instead of one
    per line/segment. We hold each line's markdown marker (####, -, 1.) ourselves
    and mask inline math/code/<<terms>>/[[C]] with ZZnZZ sentinels (verified to
    survive Argos, incl. the English pivot), then translate all line-bodies joined
    by newlines in a single call. Falls back to per-line if the newline count
    drifts, so alignment is never lost."""
    lines = block.split("\n")
    prefixes, bodies = [], []
    for ln in lines:
        if not ln.strip():
            prefixes.append(ln); bodies.append(None); continue
        m = _PREFIX.match(ln)
        prefixes.append(m.group(1) or ""); bodies.append(m.group(2))

    spans: list[str] = []
    def mask(b: str) -> str:
        return _INLINE.sub(lambda mm: (spans.append(mm.group(0)), "ZZ%dZZ" % (len(spans) - 1))[1], b)

    idxs = [i for i, b in enumerate(bodies) if b is not None and b.strip()]
    if not idxs:
        return block
    masked = [mask(bodies[i]) for i in idxs]
    joined = "\n".join(masked)
    trans = tr.translate(joined, frm, to)
    parts = trans.split("\n")
    if len(parts) != len(masked):                 # newline drift → safe per-line
        parts = [tr.translate(mb, frm, to) for mb in masked]

    def unmask(t: str) -> str:
        for i, s in enumerate(spans):
            t = t.replace("ZZ%dZZ" % i, s)
        return t

    res = list(lines)
    for k, i in enumerate(idxs):
        res[i] = prefixes[i] + unmask(parts[k])
    return "\n".join(res)


def translate_text(text: str, source: str, target: str) -> str:
    """Translate markdown prose source→target, leaving structure/math/terms intact."""
    if not (text or "").strip() or source == target:
        return text or ""
    _, tr = _mods()
    if not tr:
        raise RuntimeError(f"Argos indisponible ({_argos_err}).")
    _ensure(source, target)
    out, last = [], 0
    for m in _FENCE.finditer(text):         # keep fenced ```fig```/code blocks verbatim
        out.append(_tr_block(text[last:m.start()], source, target, tr))
        out.append(m.group(0))
        last = m.end()
    out.append(_tr_block(text[last:], source, target, tr))
    return "".join(out)


def translate_batch(texts: list[str], source: str, target: str) -> list[str]:
    return [translate_text(t or "", source, target) for t in (texts or [])]
