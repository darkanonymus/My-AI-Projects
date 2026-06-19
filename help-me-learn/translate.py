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


def _seg(s: str, frm: str, to: str, tr) -> str:
    if not s.strip():
        return s
    # Argos trims surrounding whitespace; keep it so spans like <<term>> and
    # $math$ don't get glued to adjacent words.
    lead = s[: len(s) - len(s.lstrip())]
    trail = s[len(s.rstrip()):]
    return lead + tr.translate(s.strip(), frm, to) + trail


def _line(ln: str, frm: str, to: str, tr) -> str:
    if not ln.strip():
        return ln
    m = _PREFIX.match(ln)
    prefix, body = (m.group(1) or ""), m.group(2)
    out, last = [], 0
    for mm in _INLINE.finditer(body):       # keep inline math/code/terms verbatim
        out.append(_seg(body[last:mm.start()], frm, to, tr))
        out.append(mm.group(0))
        last = mm.end()
    out.append(_seg(body[last:], frm, to, tr))
    return prefix + "".join(out)


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
        block = text[last:m.start()]
        out.append("\n".join(_line(ln, source, target, tr) for ln in block.split("\n")))
        out.append(m.group(0))
        last = m.end()
    tail = text[last:]
    out.append("\n".join(_line(ln, source, target, tr) for ln in tail.split("\n")))
    return "".join(out)


def translate_batch(texts: list[str], source: str, target: str) -> list[str]:
    return [translate_text(t or "", source, target) for t in (texts or [])]
