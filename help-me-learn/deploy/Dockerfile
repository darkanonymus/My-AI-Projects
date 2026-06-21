# Help me Learn — backend image (FastAPI + Piper TTS + Whisper STT + Argos).
# Works on x86_64 and arm64 (Oracle Always Free is arm64 / Ampere).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/data \
    HF_HOME=/data/hf \
    HML_DB=/data/data.db \
    PIPER_VOICES_DIR=/data/voices

WORKDIR /app

# espeak-ng: Piper phonemization fallback. ffmpeg: extra codec safety for STT.
RUN apt-get update && apt-get install -y --no-install-recommends \
        espeak-ng ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
# argostranslate -> stanza -> torch. By default torch drags in ~3.4 GB of CUDA
# packages (nvidia-*, triton) that are useless on this CPU-only box. Pre-install
# CPU-only torch so the transitive dependency is already satisfied without CUDA.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install -r requirements.txt
# Patch stanza CVE-2026-54499 (pip-audit). argostranslate requires stanza with no
# upper bound, so a targeted upgrade is safe — whereas pinning it in requirements.txt
# makes pip backtrack and try to build PyAV from source, which fails.
RUN pip install --no-cache-dir --upgrade "stanza>=1.12.2"

COPY . .

# /data holds everything that must persist (DB, voices, HF + Argos model caches)
VOLUME ["/data"]
EXPOSE 8000

RUN chmod +x deploy/entrypoint.sh
CMD ["bash", "deploy/entrypoint.sh"]
