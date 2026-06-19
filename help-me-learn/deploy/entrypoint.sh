#!/usr/bin/env bash
# Container start: fetch Piper voices on first boot (persisted under /data/voices),
# then run the server. Whisper + Argos models download lazily on first use into
# /data (HF_HOME / HOME), so they persist across restarts too.
set -e

export PIPER_VOICES_DIR="${PIPER_VOICES_DIR:-/data/voices}"
mkdir -p "$PIPER_VOICES_DIR"

if [ -z "$(ls -A "$PIPER_VOICES_DIR"/*.onnx 2>/dev/null)" ]; then
  echo "[entrypoint] downloading Piper voices into $PIPER_VOICES_DIR ..."
  PIPER_VOICES_DIR="$PIPER_VOICES_DIR" python scripts/download_voices.py || \
    echo "[entrypoint] voice download failed — will fall back to Web Speech until fixed."
fi

exec uvicorn server:app --host 0.0.0.0 --port 8000
