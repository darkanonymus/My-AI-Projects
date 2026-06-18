"""
stt.py — server-side speech-to-text for Help me Learn.

Why: the browser's Web Speech `SpeechRecognition` (used to hear a spoken
question) does NOT work on iOS Safari. To make the hands-free voice Q&A work on
every platform, the frontend records the question with MediaRecorder and POSTs
the audio here; we transcribe it locally with faster-whisper (offline, free).

Engine: faster-whisper (CTranslate2). The model is downloaded once from
Hugging Face on first use (WHISPER_MODEL, default "base"). Decoding handles the
WebM/Opus that MediaRecorder produces via PyAV.

Degrades gracefully: if faster-whisper isn't installed, `available()` is False
and the frontend falls back to Web Speech (Android/desktop only).
"""
from __future__ import annotations

import os
import tempfile

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")      # tiny|base|small|medium|large-v3
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")

_model = None
_loaded = False
_err: str | None = None


def _can_import() -> bool:
    global _err
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception as e:  # noqa: BLE001
        _err = f"{type(e).__name__}: {e}"
        return False


def available() -> bool:
    """True when faster-whisper is importable (the model downloads on first use)."""
    return _can_import()


def status() -> dict:
    return {
        "available": available(),
        "engine": "faster-whisper",
        "model": MODEL_SIZE,
        "loaded": _model is not None,
        "error": _err,
    }


def _load():
    """Construct the model once (downloads it on first call)."""
    global _model, _loaded, _err
    if _loaded:
        return _model
    _loaded = True
    try:
        from faster_whisper import WhisperModel
        _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
    except Exception as e:  # noqa: BLE001
        _err = f"{type(e).__name__}: {e}"
        _model = None
    return _model


def transcribe(audio_bytes: bytes, lang: str | None = "fr", suffix: str = ".webm") -> str:
    """Transcribe recorded audio to text. `lang` = 2-letter code or None to auto-detect."""
    if not audio_bytes:
        raise ValueError("Audio vide.")
    model = _load()
    if model is None:
        raise RuntimeError(f"Whisper indisponible ({_err}). Lance : pip install faster-whisper")

    lang = (lang or "")[:2].lower() or None
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        path = f.name
    try:
        segments, _info = model.transcribe(
            path, language=lang, beam_size=1, vad_filter=True,
        )
        return "".join(seg.text for seg in segments).strip()
    finally:
        try:
            os.unlink(path)
        except Exception:  # noqa: BLE001
            pass
