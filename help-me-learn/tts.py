"""
tts.py — server-side text-to-speech for Help me Learn.

Why this exists: the browser's Web Speech `speechSynthesis` STOPS the moment the
tab is backgrounded or the screen is locked, so it can never deliver
YouTube-Premium-style background listening. Real audio bytes served into an
`<audio>` element keep playing in the background — so we synthesize them here.

Engine: Piper (https://github.com/rhasspy/piper) — runs locally in this Python
process, free, unlimited, offline. Voices are downloaded once into ./voices/
(see scripts/download_voices.py). Synthesized clips are cached on disk keyed by
(lang, voice, text) so re-reading a lesson costs nothing and is instant.

Everything degrades gracefully: if Piper isn't installed or no voice model is
present, `available()` is False and the frontend falls back to Web Speech
(foreground-only) — nothing breaks.
"""
from __future__ import annotations

import hashlib
import io
import os
import pathlib
import wave

ROOT = pathlib.Path(__file__).parent
VOICES_DIR = pathlib.Path(os.environ.get("PIPER_VOICES_DIR", str(ROOT / "voices")))
CACHE_DIR = ROOT / ".tts_cache"
try:
    CACHE_DIR.mkdir(exist_ok=True)
except Exception:  # noqa: BLE001
    pass

# app language code -> Piper voice model basename (file lives at
# voices/<name>.onnx with its config at voices/<name>.onnx.json).
# Override any of these via env if you prefer a different voice.
VOICE_FILES = {
    "fr": os.environ.get("PIPER_VOICE_FR", "fr_FR-siwis-medium"),
    "de": os.environ.get("PIPER_VOICE_DE", "de_DE-thorsten-medium"),
    "en": os.environ.get("PIPER_VOICE_EN", "en_US-amy-medium"),
    "es": os.environ.get("PIPER_VOICE_ES", "es_ES-davefx-medium"),
    "it": os.environ.get("PIPER_VOICE_IT", "it_IT-paola-medium"),
    "pt": os.environ.get("PIPER_VOICE_PT", "pt_BR-faber-medium"),
}

_voices: dict[str, object] = {}   # lang -> loaded PiperVoice (lazy, cached)
_piper_err: str | None = None
_PiperVoice = None


def _load_piper():
    """Import PiperVoice once; tolerate the two import paths Piper has shipped."""
    global _PiperVoice, _piper_err
    if _PiperVoice is not None:
        return _PiperVoice
    try:
        try:
            from piper.voice import PiperVoice  # piper-tts >= 1.x
        except Exception:  # noqa: BLE001
            from piper import PiperVoice  # older layout
        _PiperVoice = PiperVoice
        return _PiperVoice
    except Exception as e:  # noqa: BLE001
        _piper_err = f"{type(e).__name__}: {e}"
        return None


def _voice_path(lang: str) -> pathlib.Path | None:
    name = VOICE_FILES.get(lang) or VOICE_FILES["fr"]
    onnx = VOICES_DIR / f"{name}.onnx"
    return onnx if onnx.exists() else None


def available() -> bool:
    """True when we can actually synthesize (Piper importable + French voice present)."""
    return bool(_load_piper()) and _voice_path("fr") is not None


def status() -> dict:
    """Reported by /api/health so the UI knows whether background audio is possible."""
    return {
        "available": available(),
        "engine": "piper",
        "piper_installed": bool(_load_piper()),
        "error": _piper_err,
        "voices": {lang: (_voice_path(lang) is not None) for lang in VOICE_FILES},
        "voices_dir": str(VOICES_DIR),
    }


def _get_voice(lang: str):
    PiperVoice = _load_piper()
    if not PiperVoice:
        raise RuntimeError(
            f"Piper n'est pas installé ({_piper_err}). Lance : pip install piper-tts"
        )
    if lang not in _voices:
        p = _voice_path(lang)
        if p is None:                      # requested voice missing -> fall back to French
            p, lang = _voice_path("fr"), "fr"
        if p is None:
            raise RuntimeError(
                f"Aucune voix Piper trouvée dans {VOICES_DIR}. "
                f"Lance : python scripts/download_voices.py"
            )
        cfg = pathlib.Path(str(p) + ".json")
        _voices[lang] = PiperVoice.load(str(p), config_path=str(cfg) if cfg.exists() else None)
    return _voices[lang]


def _synth_wav(voice, text: str) -> bytes:
    """Synthesize `text` to WAV bytes, tolerant of Piper API drift across versions."""
    # piper-tts >= 1.3: synthesize_wav(text, wav_file) writes a full WAV.
    synth_wav = getattr(voice, "synthesize_wav", None)
    if callable(synth_wav):
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            synth_wav(text, wf)
        return buf.getvalue()

    # piper-tts >= 1.3 chunk API: synthesize(text) -> Iterable[AudioChunk].
    try:
        chunks = list(voice.synthesize(text))
        if chunks and hasattr(chunks[0], "audio_int16_bytes"):
            first = chunks[0]
            pcm = b"".join(c.audio_int16_bytes for c in chunks)
            out = io.BytesIO()
            with wave.open(out, "wb") as wf:
                wf.setnchannels(getattr(first, "sample_channels", 1) or 1)
                wf.setsampwidth(getattr(first, "sample_width", 2) or 2)
                wf.setframerate(getattr(first, "sample_rate", 22050) or 22050)
                wf.writeframes(pcm)
            return out.getvalue()
    except TypeError:
        pass

    # piper-tts 1.x legacy: synthesize(text, wav_file).
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize(text, wf)
    return buf.getvalue()


def synthesize_segments(segments: list[dict]) -> bytes:
    """Synthesize a list of [{text, lang}] into ONE gapless WAV — each segment
    spoken by its language's voice, concatenated. Lets a French sentence read
    its German terms in a German voice without the choppiness of separate clips.
    All Piper medium voices are 22050 Hz / 16-bit / mono, so PCM concatenates
    cleanly. Cached as a whole (and each segment is cached individually too)."""
    segs = [s for s in (segments or []) if (s.get("text") or "").strip()]
    if not segs:
        raise ValueError("Aucun segment.")
    if len(segs) == 1:
        return synthesize(segs[0]["text"], segs[0].get("lang", "fr"))

    sig = "||".join(f"{(s.get('lang') or 'fr')[:2]}:{s['text']}" for s in segs)
    key = hashlib.sha1(("seg|" + sig).encode("utf-8")).hexdigest()
    cache = CACHE_DIR / f"{key}.wav"
    if cache.exists():
        try:
            return cache.read_bytes()
        except Exception:  # noqa: BLE001
            pass

    nchannels = sampwidth = framerate = None
    pcm_parts: list[bytes] = []
    for s in segs:
        with wave.open(io.BytesIO(synthesize(s["text"], s.get("lang", "fr"))), "rb") as wf:
            nchannels, sampwidth, framerate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
            pcm_parts.append(wf.readframes(wf.getnframes()))

    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(nchannels or 1)
        wf.setsampwidth(sampwidth or 2)
        wf.setframerate(framerate or 22050)
        wf.writeframes(b"".join(pcm_parts))
    data = out.getvalue()
    try:
        cache.write_bytes(data)
    except Exception:  # noqa: BLE001
        pass
    return data


def synthesize(text: str, lang: str = "fr") -> bytes:
    """Return WAV bytes for `text` in `lang` ('fr'/'de'/'en'). Cached on disk."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Texte vide.")
    if len(text) > 5000:
        text = text[:5000]
    lang = (lang or "fr")[:2].lower()
    if lang not in VOICE_FILES:
        lang = "fr"

    key = hashlib.sha1(f"{lang}|{VOICE_FILES.get(lang)}|{text}".encode("utf-8")).hexdigest()
    cache = CACHE_DIR / f"{key}.wav"
    if cache.exists():
        try:
            return cache.read_bytes()
        except Exception:  # noqa: BLE001
            pass

    data = _synth_wav(_get_voice(lang), text)
    try:
        cache.write_bytes(data)
    except Exception:  # noqa: BLE001
        pass
    return data
