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
RUN pip install -r requirements.txt

COPY . .

# /data holds everything that must persist (DB, voices, HF + Argos model caches)
VOLUME ["/data"]
EXPOSE 8000

RUN chmod +x deploy/entrypoint.sh
CMD ["bash", "deploy/entrypoint.sh"]
