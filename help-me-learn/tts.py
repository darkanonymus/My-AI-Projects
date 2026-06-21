"""
tts.py — server-side text-to-speech for Help me Learn.

Why this exists: the browser's Web Speech `speechSynthesis` STOPS the moment the
tab is backgrounded or the screen is locked, so it can never deliver
YouTube-Premium-style background listening. Real audio bytes served into an
`<audio>` element keep playing in the background — so we synthesize them here.

Two engines, with automatic fallback:
  1. edge-tts (PRIMARY) — Microsoft Edge's neural voices (Azure quality), free,
     no API key, no GPU. Online (the server is always online anyway). Best
     quality across all 6 languages, German included. Returns MP3 → decoded to
     WAV via ffmpeg so it slots into the existing WAV pipeline (incl. the gapless
     multi-voice "segments" feature).
  2. Piper (FALLBACK) — runs locally, offline, no quality match but reliable if
     the (unofficial) edge endpoint ever fails. Voices in ./voices/.

Everything degrades gracefully: edge → Piper → (frontend) Web Speech. Synthesized
clips are cached on disk keyed by (engine, voice, normalized text).
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import os
import pathlib
import re
import shutil
import subprocess
import wave

ROOT = pathlib.Path(__file__).parent
VOICES_DIR = pathlib.Path(os.environ.get("PIPER_VOICES_DIR", str(ROOT / "voices")))
CACHE_DIR = ROOT / ".tts_cache"
try:
    CACHE_DIR.mkdir(exist_ok=True)
except Exception:  # noqa: BLE001
    pass

# app language code -> Piper voice model basename (FALLBACK engine).
VOICE_FILES = {
    "fr": os.environ.get("PIPER_VOICE_FR", "fr_FR-tom-medium"),
    "de": os.environ.get("PIPER_VOICE_DE", "de_DE-thorsten-medium"),
    "en": os.environ.get("PIPER_VOICE_EN", "en_US-lessac-medium"),
    "es": os.environ.get("PIPER_VOICE_ES", "es_ES-davefx-medium"),
    "it": os.environ.get("PIPER_VOICE_IT", "it_IT-paola-medium"),
    "pt": os.environ.get("PIPER_VOICE_PT", "pt_BR-faber-medium"),
}

# app language code -> default edge (Azure) neural voice (PRIMARY engine).
# Overridable via env (e.g. EDGE_VOICE_FR=fr-FR-HenriNeural).
EDGE_DEFAULT = {
    "fr": os.environ.get("EDGE_VOICE_FR", "fr-FR-DeniseNeural"),
    "de": os.environ.get("EDGE_VOICE_DE", "de-DE-KatjaNeural"),
    "en": os.environ.get("EDGE_VOICE_EN", "en-US-AriaNeural"),
    "es": os.environ.get("EDGE_VOICE_ES", "es-ES-ElviraNeural"),
    "it": os.environ.get("EDGE_VOICE_IT", "it-IT-ElsaNeural"),
    "pt": os.environ.get("EDGE_VOICE_PT", "pt-BR-FranciscaNeural"),
}
# Voices offered in the in-app picker so the user can A/B and choose. The
# *Multilingual* voices speak several languages in one voice — ideal for a
# French sentence that reads its German terms without a jarring engine switch.
EDGE_CHOICES = {
    "fr": ["fr-FR-DeniseNeural", "fr-FR-HenriNeural", "fr-FR-RemyMultilingualNeural", "fr-FR-VivienneMultilingualNeural"],
    "de": ["de-DE-KatjaNeural", "de-DE-ConradNeural", "de-DE-SeraphinaMultilingualNeural"],
    "en": ["en-US-AriaNeural", "en-US-GuyNeural", "en-GB-SoniaNeural"],
    "es": ["es-ES-ElviraNeural", "es-ES-AlvaroNeural"],
    "it": ["it-IT-ElsaNeural", "it-IT-DiegoNeural"],
    "pt": ["pt-BR-FranciscaNeural", "pt-BR-AntonioNeural"],
}
_EDGE_TIMEOUT = float(os.environ.get("EDGE_TTS_TIMEOUT", "25"))

_voices: dict[str, object] = {}   # piper model name -> loaded PiperVoice (lazy)
_piper_err: str | None = None
_PiperVoice = None
_edge_err: str | None = None
_edge_last_fail: str | None = None

# ---------------------------------------------------------------------------
# Text normalization — read symbols/numbers as words (shared by both engines).
# ---------------------------------------------------------------------------
_SYMBOLS = {
    "fr": {"%": " pour cent ", "→": " vers ", "->": " vers ", "×": " fois ", "÷": " divisé par ", "≈": " environ ", "≤": " inférieur ou égal à ", "≥": " supérieur ou égal à ", "≠": " différent de ", "±": " plus ou moins ", "°": " degrés ", "√": " racine de ", "∑": " somme ", "∞": " l'infini ", "&": " et "},
    "de": {"%": " Prozent ", "→": " nach ", "×": " mal ", "÷": " geteilt durch ", "≈": " etwa ", "≤": " kleiner gleich ", "≥": " größer gleich ", "≠": " ungleich ", "±": " plus minus ", "°": " Grad ", "√": " Wurzel aus ", "∑": " Summe ", "∞": " unendlich ", "&": " und "},
    "en": {"%": " percent ", "→": " to ", "×": " times ", "÷": " divided by ", "≈": " about ", "≤": " less than or equal to ", "≥": " greater than or equal to ", "≠": " not equal to ", "±": " plus or minus ", "°": " degrees ", "√": " square root of ", "∑": " sum ", "∞": " infinity ", "&": " and "},
    "es": {"%": " por ciento ", "→": " a ", "×": " por ", "÷": " dividido por ", "≈": " aproximadamente ", "≤": " menor o igual que ", "≥": " mayor o igual que ", "≠": " distinto de ", "±": " más menos ", "°": " grados ", "√": " raíz de ", "∑": " suma ", "∞": " infinito ", "&": " y "},
    "it": {"%": " per cento ", "→": " a ", "×": " per ", "÷": " diviso ", "≈": " circa ", "≤": " minore o uguale a ", "≥": " maggiore o uguale a ", "≠": " diverso da ", "±": " più o meno ", "°": " gradi ", "√": " radice di ", "∑": " somma ", "∞": " infinito ", "&": " e "},
    "pt": {"%": " por cento ", "→": " para ", "×": " vezes ", "÷": " dividido por ", "≈": " cerca de ", "≤": " menor ou igual a ", "≥": " maior ou igual a ", "≠": " diferente de ", "±": " mais ou menos ", "°": " graus ", "√": " raiz de ", "∑": " soma ", "∞": " infinito ", "&": " e "},
}


def _normalize(text: str, lang: str) -> str:
    syms = _SYMBOLS.get(lang, _SYMBOLS["fr"])
    for k, v in syms.items():
        if k in text:
            text = text.replace(k, v)
    try:                                    # spell out standalone integers
        from num2words import num2words
        def _n(m):
            try:
                return num2words(int(m.group(0)), lang=lang)
            except Exception:  # noqa: BLE001
                return m.group(0)
        text = re.sub(r"(?<![\d.,])\d{1,9}(?![\d.,])", _n, text)
    except Exception:  # noqa: BLE001
        pass
    return re.sub(r"\s{2,}", " ", text).strip()


# ---------------------------------------------------------------------------
# edge-tts (PRIMARY) — neural voices, MP3 → WAV via ffmpeg
# ---------------------------------------------------------------------------
_ffmpeg: str | None = None
def _ffmpeg_path() -> str | None:
    global _ffmpeg
    if _ffmpeg is None:
        _ffmpeg = shutil.which("ffmpeg") or ""
    return _ffmpeg or None


def _edge_importable() -> bool:
    global _edge_err
    try:
        import edge_tts  # noqa: F401
        return True
    except Exception as e:  # noqa: BLE001
        _edge_err = f"{type(e).__name__}: {e}"
        return False


def _edge_available() -> bool:
    """edge-tts is usable when the package is importable AND ffmpeg is present
    (we need it to decode the MP3). Endpoint reachability is handled at call
    time via the Piper fallback."""
    return _edge_importable() and _ffmpeg_path() is not None


def _is_piper_voice(voice: str | None) -> bool:
    if not voice:
        return False
    v = str(voice)
    if v.endswith(("-medium", "-low", "-high", "-x_low")):
        return True
    return _voice_path_by_name(v) is not None


def _edge_voice_for(lang: str, voice: str | None) -> str:
    if voice and ("Neural" in str(voice) or re.match(r"^[a-z]{2}-[A-Z]{2}-", str(voice))):
        return str(voice)
    return EDGE_DEFAULT.get(lang, EDGE_DEFAULT["fr"])


def _edge_mp3(text: str, voice: str) -> bytes:
    """Synthesize via edge-tts → MP3 bytes (async API run in a fresh loop)."""
    import edge_tts

    async def _run() -> bytes:
        comm = edge_tts.Communicate(text, voice)
        buf = bytearray()
        async for chunk in comm.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                buf.extend(chunk["data"])
        return bytes(buf)

    return asyncio.run(asyncio.wait_for(_run(), timeout=_EDGE_TIMEOUT))


def _pcm_from_mp3(mp3: bytes) -> bytes:
    """Decode MP3 → raw PCM s16le, mono, 22050 Hz (matches Piper, so clips
    concatenate cleanly in synthesize_segments)."""
    if not mp3:
        raise RuntimeError("edge-tts a renvoyé un audio vide.")
    ff = _ffmpeg_path()
    if not ff:
        raise RuntimeError("ffmpeg introuvable.")
    p = subprocess.run(
        [ff, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "s16le", "-ar", "22050", "-ac", "1", "pipe:1"],
        input=mp3, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError("Décodage ffmpeg du MP3 edge-tts échoué.")
    return p.stdout


def _wav_from_pcm(pcm: bytes, rate: int = 22050) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm)
    return out.getvalue()


def _edge_wav(text: str, voice: str) -> bytes:
    return _wav_from_pcm(_pcm_from_mp3(_edge_mp3(text, voice)))


# ---------------------------------------------------------------------------
# Piper (FALLBACK) — local offline voices
# ---------------------------------------------------------------------------
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


def _name_for(lang: str, voice: str | None = None) -> str:
    return voice or VOICE_FILES.get(lang) or VOICE_FILES["fr"]


def _voice_path_by_name(name: str) -> pathlib.Path | None:
    onnx = VOICES_DIR / f"{name}.onnx"
    return onnx if onnx.exists() else None


def _voice_path(lang: str, voice: str | None = None) -> pathlib.Path | None:
    return _voice_path_by_name(_name_for(lang, voice))


def list_installed_voices() -> list[dict]:
    """Every Piper voice present on disk, grouped by language code."""
    out = []
    try:
        for p in sorted(VOICES_DIR.glob("*.onnx")):
            nm = p.stem
            out.append({"name": nm, "lang": nm.split("_", 1)[0].lower()})
    except Exception:  # noqa: BLE001
        pass
    return out


def _get_voice(lang: str, voice: str | None = None):
    PiperVoice = _load_piper()
    if not PiperVoice:
        raise RuntimeError(
            f"Piper n'est pas installé ({_piper_err}). Lance : pip install piper-tts"
        )
    name = _name_for(lang, voice)
    if name not in _voices:
        p = _voice_path_by_name(name)
        if p is None:                      # requested voice missing -> language default -> French
            name = VOICE_FILES.get(lang) or VOICE_FILES["fr"]
            p = _voice_path_by_name(name)
        if p is None:
            name = VOICE_FILES["fr"]
            p = _voice_path_by_name(name)
        if p is None:
            raise RuntimeError(
                f"Aucune voix Piper trouvée dans {VOICES_DIR}. "
                f"Lance : python scripts/download_voices.py"
            )
        cfg = pathlib.Path(str(p) + ".json")
        _voices[name] = PiperVoice.load(str(p), config_path=str(cfg) if cfg.exists() else None)
    return _voices[name]


def _synth_wav(voice, text: str) -> bytes:
    """Synthesize `text` to WAV bytes, tolerant of Piper API drift across versions."""
    synth_wav = getattr(voice, "synthesize_wav", None)
    if callable(synth_wav):
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            synth_wav(text, wf)
        return buf.getvalue()

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

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize(text, wf)
    return buf.getvalue()


def _piper_wav(text: str, lang: str, voice: str | None) -> bytes:
    pv_voice = voice if _is_piper_voice(voice) else None
    return _synth_wav(_get_voice(lang, pv_voice), text)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def available() -> bool:
    """True when we can synthesize at all (edge OR Piper)."""
    if _edge_available():
        return True
    return bool(_load_piper()) and _voice_path("fr") is not None


def status() -> dict:
    """Reported by /api/health so the UI knows what's possible + which voices to offer."""
    edge_ok = _edge_available()
    voices: list[dict] = []
    for lang, names in EDGE_CHOICES.items():
        for nm in names:
            voices.append({"name": nm, "lang": lang, "engine": "edge"})
    voices += [{**v, "engine": "piper"} for v in list_installed_voices()]
    return {
        "available": available(),
        "engine": "edge" if edge_ok else ("piper" if (_load_piper() and _voice_path("fr")) else "none"),
        "edge": edge_ok,
        "edge_error": _edge_err,
        "edge_last_fail": _edge_last_fail,
        "piper_installed": bool(_load_piper()),
        "error": _piper_err,
        "voices": {lang: (_voice_path(lang) is not None) for lang in VOICE_FILES},
        "voices_installed": voices,
        "voices_dir": str(VOICES_DIR),
    }


def synthesize(text: str, lang: str = "fr", voice: str | None = None) -> bytes:
    """Return WAV bytes for `text` in `lang`, optionally with a specific `voice`.
    edge-tts first (neural quality); on any failure, fall back to Piper. Cached
    on disk per (engine, voice, normalized text)."""
    global _edge_last_fail
    text = (text or "").strip()
    if not text:
        raise ValueError("Texte vide.")
    if len(text) > 5000:
        text = text[:5000]
    lang = (lang or "fr")[:2].lower()
    if lang not in VOICE_FILES:
        lang = "fr"
    norm = _normalize(text, lang)

    # --- edge-tts (primary) unless the user explicitly picked a Piper voice ---
    if _edge_available() and not _is_piper_voice(voice):
        ev = _edge_voice_for(lang, voice)
        key = hashlib.sha1(f"edge|{ev}|{norm}".encode("utf-8"), usedforsecurity=False).hexdigest()
        cache = CACHE_DIR / f"{key}.wav"
        if cache.exists():
            try:
                return cache.read_bytes()
            except Exception:  # noqa: BLE001
                pass
        try:
            data = _edge_wav(norm, ev)
            try:
                cache.write_bytes(data)
            except Exception:  # noqa: BLE001
                pass
            return data
        except Exception as e:  # noqa: BLE001
            _edge_last_fail = f"{type(e).__name__}: {e}"
            print(f"[tts] edge-tts failed ({_edge_last_fail}) — falling back to Piper", flush=True)

    # --- Piper (fallback) ---
    name = _name_for(lang, voice if _is_piper_voice(voice) else None)
    key = hashlib.sha1(f"{name}|{norm}".encode("utf-8"), usedforsecurity=False).hexdigest()
    cache = CACHE_DIR / f"{key}.wav"
    if cache.exists():
        try:
            return cache.read_bytes()
        except Exception:  # noqa: BLE001
            pass
    data = _piper_wav(norm, lang, voice)
    try:
        cache.write_bytes(data)
    except Exception:  # noqa: BLE001
        pass
    return data


def synthesize_segments(segments: list[dict]) -> bytes:
    """Synthesize a list of [{text, lang, voice?}] into ONE gapless WAV — each
    segment in its language's voice, concatenated. Lets a French sentence read
    its German terms in a German voice without choppiness. Both engines emit
    22050 Hz / 16-bit / mono PCM, so the parts concatenate cleanly. Cached as a
    whole (each segment is cached individually too)."""
    segs = [s for s in (segments or []) if (s.get("text") or "").strip()]
    if not segs:
        raise ValueError("Aucun segment.")
    if len(segs) == 1:
        return synthesize(segs[0]["text"], segs[0].get("lang", "fr"), segs[0].get("voice"))

    sig = "||".join(f"{(s.get('voice') or _name_for((s.get('lang') or 'fr')[:2]))}:{s['text']}" for s in segs)
    key = hashlib.sha1(("seg|" + sig).encode("utf-8"), usedforsecurity=False).hexdigest()
    cache = CACHE_DIR / f"{key}.wav"
    if cache.exists():
        try:
            return cache.read_bytes()
        except Exception:  # noqa: BLE001
            pass

    nchannels = sampwidth = framerate = None
    pcm_parts: list[bytes] = []
    for s in segs:
        with wave.open(io.BytesIO(synthesize(s["text"], s.get("lang", "fr"), s.get("voice"))), "rb") as wf:
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
