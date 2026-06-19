"""
download_voices.py — fetch the Piper voice models for read-aloud.

Run once:
    python scripts/download_voices.py            # all languages, all curated voices
    python scripts/download_voices.py fr de      # only those languages

Each language ships a small CURATED SET so the in-app voice picker has a real
choice. The first voice in each list is the default (the most natural one).
Models land in ./voices/ (gitignored). Pulled from the official
rhasspy/piper-voices repo on Hugging Face.
"""
from __future__ import annotations

import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
VOICES_DIR = ROOT / "voices"
BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# lang -> curated voice models (first = default). Names are
# "<locale>-<speaker>-<quality>"; the repo subpath is derived from them.
VOICES = {
    "fr": ["fr_FR-tom-medium", "fr_FR-siwis-medium", "fr_FR-upmc-medium"],
    "en": ["en_US-lessac-medium", "en_US-amy-medium", "en_US-ryan-high"],
    "de": ["de_DE-thorsten-medium", "de_DE-thorsten-high", "de_DE-kerstin-low"],
    "es": ["es_ES-davefx-medium", "es_ES-sharvard-medium"],
    "it": ["it_IT-paola-medium", "it_IT-riccardo-x_low"],
    "pt": ["pt_BR-faber-medium", "pt_BR-edresson-low"],
}


def _subpath(name: str) -> str:
    locale, speaker, quality = name.split("-", 2)   # e.g. en_US, lessac, medium
    return f"{locale.split('_')[0]}/{locale}/{speaker}/{quality}/{name}"


def _download(url: str, dest: pathlib.Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  [have] {dest.name}")
        return
    print(f"  [get]  {dest.name}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "help-me-learn/1.0"})
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:  # noqa: S310
        while chunk := r.read(1 << 16):
            f.write(chunk)
    tmp.replace(dest)


def main(langs: list[str]) -> int:
    VOICES_DIR.mkdir(exist_ok=True)
    langs = langs or list(VOICES.keys())
    rc = 0
    for lang in langs:
        if lang not in VOICES:
            print(f"!! unknown language {lang!r} (known: {', '.join(VOICES)})")
            rc = 1
            continue
        print(f"[{lang}]")
        for name in VOICES[lang]:
            sub = _subpath(name)
            try:
                _download(f"{BASE}/{sub}.onnx", VOICES_DIR / f"{name}.onnx")
                _download(f"{BASE}/{sub}.onnx.json", VOICES_DIR / f"{name}.onnx.json")
            except Exception as e:  # noqa: BLE001
                print(f"   !! {name} failed: {e}")
                rc = 1
    print(f"\nDone -> {VOICES_DIR}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main([a.lower() for a in sys.argv[1:]]))
