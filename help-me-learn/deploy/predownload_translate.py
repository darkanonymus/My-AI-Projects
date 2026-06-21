#!/usr/bin/env python3
"""Pre-download Argos language packs + warm stanza models at DEPLOY time, so a
user's first translation never triggers a slow lazy download (which was timing
the browser out at ~144s when the HuggingFace hub throttled).

Runs in the background from the entrypoint, as the non-root `app` user. Idempotent:
once every pair succeeds, a marker file is written and later boots skip the work.
Failures are tolerated — the lazy-download fallback in translate.py still covers
anything that didn't pre-install, and the next boot retries (no marker).

Languages pivot through English, so installing each X<->en covers every X<->Y pair.
Doing a tiny real translation per direction also warms the stanza sentence model.
"""
import os
import sys
import time

# translate.py lives one level up (/app); make it importable regardless of cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MARKER = os.path.join(os.environ.get("HOME", "/data"), ".translate_prewarmed")
# en is the pivot; we install/warm each of these against English (both directions).
LANGS = [s.strip() for s in os.environ.get("TRANSLATE_PREWARM_LANGS", "fr,de,es,it,pt").split(",") if s.strip()]


def main() -> None:
    if os.path.exists(MARKER):
        print("[predownload] already prewarmed — skipping", flush=True)
        return
    try:
        import translate
    except Exception as e:  # noqa: BLE001
        print(f"[predownload] cannot import translate: {e}", flush=True)
        return
    if not translate.available():
        print("[predownload] argos unavailable — skipping", flush=True)
        return

    all_ok = True
    for x in LANGS:
        for src, tgt, txt in ((x, "en", "Ceci est un court test."), ("en", x, "This is a short test.")):
            t = time.time()
            try:
                translate.translate_text(txt, src, tgt)
                print(f"[predownload] {src}->{tgt} ready ({round(time.time() - t, 1)}s)", flush=True)
            except Exception as e:  # noqa: BLE001
                all_ok = False
                print(f"[predownload] {src}->{tgt} FAILED: {e}", flush=True)

    if all_ok:
        try:
            with open(MARKER, "w") as f:
                f.write(str(int(time.time())))
            print("[predownload] all language packs ready — marker written", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[predownload] marker write failed: {e}", flush=True)
    else:
        print("[predownload] some pairs failed — will retry on next boot (no marker)", flush=True)


if __name__ == "__main__":
    main()
