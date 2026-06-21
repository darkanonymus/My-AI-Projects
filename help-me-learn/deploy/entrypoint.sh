#!/usr/bin/env bash
# Container start: runs as ROOT only long enough to prepare the persistent /data
# volume and fetch Piper voices on first boot, then DROPS PRIVILEGES and runs the
# server as the non-root `app` user (defense in depth: a compromised app process
# is not root inside the container). Whisper + Argos models download lazily into
# /data (HF_HOME / HOME), so they persist across restarts too.
set -e

export PIPER_VOICES_DIR="${PIPER_VOICES_DIR:-/data/voices}"
mkdir -p "$PIPER_VOICES_DIR"

if [ -z "$(ls -A "$PIPER_VOICES_DIR"/*.onnx 2>/dev/null)" ]; then
  echo "[entrypoint] downloading Piper voices into $PIPER_VOICES_DIR ..."
  PIPER_VOICES_DIR="$PIPER_VOICES_DIR" python scripts/download_voices.py || \
    echo "[entrypoint] voice download failed — will fall back to Web Speech until fixed."
fi

# The named volume is root-owned by default; give the app user ownership of the
# paths it writes (DB, model caches, TTS cache). Idempotent — runs each boot.
mkdir -p /app/.tts_cache
chown -R app:app /data /app/.tts_cache 2>/dev/null || true

# Pre-download the offline-translation models (Argos packs + stanza) in the
# BACKGROUND, as the app user, so the first user translation never triggers a
# slow lazy download. Non-blocking: the server starts immediately; the lazy
# fallback in translate.py covers anything not yet ready.
gosu app env HOME=/data python deploy/predownload_translate.py >> /data/predownload.log 2>&1 &

# Drop root -> run the server as the non-root `app` user. Force HOME=/data so the
# app's caches (Argos packs ~/.local, stanza models ~/stanza_resources, prewarm
# marker) land on the PERSISTENT /data volume — gosu otherwise resets HOME to
# /home/app (container layer), which is wiped on every redeploy.
exec gosu app env HOME=/data uvicorn server:app --host 0.0.0.0 --port 8000
