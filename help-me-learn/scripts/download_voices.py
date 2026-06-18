"""
download_voices.py — fetch the Piper voice models used for background audio.

Run once:
    python scripts/download_voices.py            # French + German + English
    python scripts/download_voices.py fr de      # only the ones you want

Models land in ./voices/ (gitignored). Each voice is a .onnx model + a small
.onnx.json config, pulled from the official rhasspy/piper-voices repo on
Hugging Face. French (~63 MB) is enough to start; add others as needed.
"""
from __future__ import annotations

import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
VOICES_DIR = ROOT / "voices"
BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# app lang -> (model basename, repo subpath)
VOICES = {
    "fr": ("fr_FR-siwis-medium", "fr/fr_FR/siwis/medium"),
    "de": ("de_DE-thorsten-medium", "de/de_DE/thorsten/medium"),
    "en": ("en_US-amy-medium", "en/en_US/amy/medium"),
    "es": ("es_ES-davefx-medium", "es/es_ES/davefx/medium"),
    "it": ("it_IT-paola-medium", "it/it_IT/paola/medium"),
    "pt": ("pt_BR-faber-medium", "pt/pt_BR/faber/medium"),
}


def _download(url: str, dest: pathlib.Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  [have] {dest.name}")
        return
    print(f"  [get]  {dest.name}  <-  {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "help-me-learn/1.0"})
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:  # noqa: S310
        while chunk := r.read(1 << 16):
            f.write(chunk)
    tmp.replace(dest)


def main(langs: list[str]) -> int:
    VOICES_DIR.mkdir(exist_ok=True)
    if not langs:
        langs = list(VOICES.keys())
    rc = 0
    for lang in langs:
        if lang not in VOICES:
            print(f"!! unknown language {lang!r} (known: {', '.join(VOICES)})")
            rc = 1
            continue
        name, sub = VOICES[lang]
        print(f"[{lang}] {name}")
        try:
            _download(f"{BASE}/{sub}/{name}.onnx", VOICES_DIR / f"{name}.onnx")
            _download(f"{BASE}/{sub}/{name}.onnx.json", VOICES_DIR / f"{name}.onnx.json")
        except Exception as e:  # noqa: BLE001
            print(f"   !! failed: {e}")
            rc = 1
    print(f"\nDone -> {VOICES_DIR}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main([a.lower() for a in sys.argv[1:]]))
