"""
server.py — web server for Help me Learn (the HTTP/route layer).

Wires the pieces together and serves the API + static frontend:
  • db.py        — SQLite persistence (kv state slots + course figures)
  • auth.py      — accounts: password hashing, sessions, reset (/api/auth/* router)
  • ratelimit.py — per-IP throttling for the costly endpoints
  • llm/tts/stt/translate/extract — the feature modules each route delegates to

Start:
    uvicorn server:app --reload --port 8000
or simply:
    python server.py
"""

from __future__ import annotations
import base64
import json as json_module
import os
import pathlib

# Load .env BEFORE importing the modules below, so API keys / DB path / cookie
# settings are captured on import.
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:  # noqa: BLE001
    pass

import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import llm
import tts
import stt
import translate as translate_mod
from extract import extract_pdf

import auth
from db import kv_get, kv_set, fig_get, fig_set
from auth import current_uid, state_key
from ratelimit import rate_limit

ROOT = pathlib.Path(__file__).parent
WEB = ROOT / "web"


def _log_err(context: str, exc: Exception) -> None:
    """Log the real error server-side; clients only ever see a generic message
    (so exception text never leaks paths / library internals)."""
    print(f"[error] {context}: {type(exc).__name__}: {exc}", flush=True)


async def _read_capped(upload: UploadFile, limit: int, request: Request) -> bytes:
    """Read an uploaded file into memory WITHOUT ever buffering more than `limit`.
    Rejects early on an oversized Content-Length, then reads in 1 MB chunks and
    aborts the moment the cap is exceeded — so a multi-GB POST can't OOM the box."""
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > limit + (1 << 20):
        raise HTTPException(status_code=413, detail=f"Fichier trop volumineux. Maximum : {limit // 1024 // 1024} Mo.")
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1 << 20)   # 1 MB
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail=f"Fichier trop volumineux. Maximum : {limit // 1024 // 1024} Mo.")
        chunks.append(chunk)
    return b"".join(chunks)


app = FastAPI(title="Help me Learn — local")
app.include_router(auth.router)   # /api/auth/*


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {
        "gemini": llm.gemini_status(),
        "claude": llm.claude_status(),
        "ollama": await llm.ollama_status(),
        "tts": tts.status(),
        "stt": stt.status(),
        "translate": translate_mod.status(),
        "default_provider": os.environ.get("DEFAULT_PROVIDER", "gemini"),
    }


class TranslateBody(BaseModel):
    texts: list[str]
    source: str = "fr"
    target: str


@app.post("/api/translate")
async def api_translate(body: TranslateBody, request: Request):
    """Translate a batch of course strings offline (Argos), preserving math /
    code / <<terms>> / markdown. 503 when Argos isn't installed."""
    rate_limit(request, "translate", 20, 60)
    texts = body.texts or []
    if len(texts) > 2000 or sum(len(t or "") for t in texts) > 2_000_000:
        raise HTTPException(status_code=413, detail="Lot de traduction trop volumineux.")
    if body.source == body.target:
        return {"translations": texts}
    if not translate_mod.available():
        raise HTTPException(status_code=503, detail="Traduction hors-ligne indisponible : lance « pip install argostranslate ».")
    try:
        out = await run_in_threadpool(translate_mod.translate_batch, texts, body.source, body.target)
    except Exception as e:  # noqa: BLE001
        _log_err("translate", e)
        raise HTTPException(status_code=500, detail="Traduction impossible.")
    return {"translations": out}


class TTSBody(BaseModel):
    text: str | None = None
    lang: str = "fr"
    voice: str | None = None             # specific voice (else language default)
    segments: list[dict] | None = None   # [{text, lang, voice?}] → one gapless multi-voice clip


@app.post("/api/tts")
async def api_tts(body: TTSBody, request: Request):
    """Synthesize speech → WAV bytes for background <audio> playback. Accepts
    `text`+`lang`, or `segments` for one gapless clip. 503 when no engine is set
    up — the frontend then falls back to Web Speech (foreground only)."""
    rate_limit(request, "tts", 40, 60)
    if body.segments is not None and len(body.segments) > 400:
        raise HTTPException(status_code=413, detail="Trop de segments audio.")
    if len(body.text or "") > 20000:
        raise HTTPException(status_code=413, detail="Texte trop long.")
    if not body.segments and not (body.text or "").strip():
        raise HTTPException(status_code=400, detail="Texte vide.")
    if not tts.available():
        st = tts.status()
        hint = (
            "Voix Piper absentes : lance « python scripts/download_voices.py »."
            if st.get("piper_installed")
            else "Synthèse vocale indisponible."
        )
        raise HTTPException(status_code=503, detail=hint)
    try:
        if body.segments:
            audio = await run_in_threadpool(tts.synthesize_segments, body.segments)
        else:
            audio = await run_in_threadpool(tts.synthesize, body.text, body.lang, body.voice)
    except Exception as e:  # noqa: BLE001
        _log_err("tts", e)
        raise HTTPException(status_code=500, detail="Synthèse vocale impossible.")
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.post("/api/stt")
async def api_stt(request: Request, audio: UploadFile = File(...), lang: str = "fr"):
    """Transcribe a recorded question (Whisper) → {text}. Cross-platform
    (incl. iOS) replacement for the browser's SpeechRecognition. 503 when
    faster-whisper isn't installed — the frontend then falls back to Web Speech."""
    rate_limit(request, "stt", 20, 60)
    if not stt.available():
        raise HTTPException(status_code=503, detail="Transcription indisponible : lance « pip install faster-whisper ».")
    data = await _read_capped(audio, 25 * 1024 * 1024, request)
    if not data:
        raise HTTPException(status_code=400, detail="Audio vide.")
    suffix = "." + ((audio.filename or "q.webm").rsplit(".", 1)[-1] or "webm")[:8]
    try:
        text = await run_in_threadpool(stt.transcribe, data, lang, suffix)
    except Exception as e:  # noqa: BLE001
        _log_err("stt", e)
        raise HTTPException(status_code=500, detail="Transcription impossible.")
    return {"text": text}


# ---------------------------------------------------------------------------
# Per-user state (the course library blob), scoped by the signed-in account
# ---------------------------------------------------------------------------
class StateBody(BaseModel):
    data: str   # full JSON string: {chapters, currentId, theme}


@app.get("/api/state")
async def get_state(request: Request):
    uid = current_uid(request)
    if not uid:
        # Logged out → no server state. Courses are private to an account, so a
        # public visitor (or a not-yet-signed-in device) sees nothing.
        return JSONResponse(None)
    raw = await run_in_threadpool(lambda: kv_get(state_key(uid)))
    if raw is None:
        return JSONResponse(None)
    return JSONResponse(json_module.loads(raw))


@app.post("/api/state")
async def save_state(body: StateBody, request: Request):
    uid = current_uid(request)
    if not uid:
        return {"ok": True}   # anonymous state stays local-only — never written to a shared bucket
    # Strip base64 image blobs before persisting — keeps DB small,
    # text content (lessons, quiz, flashcards) is fully preserved.
    try:
        state = json_module.loads(body.data)
        for ch in state.get("chapters", []):
            for fig in ch.get("figures", []):
                fig.pop("url", None)
        clean = json_module.dumps(state, ensure_ascii=False)
    except Exception:
        clean = body.data
    await run_in_threadpool(lambda: kv_set(state_key(uid), clean))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Course figures — the base64 images extracted from PDFs, stored out-of-band
# (see db.figures). Uploaded once at import; served as real images.
# ---------------------------------------------------------------------------
class FiguresBody(BaseModel):
    courseId: str
    figures: list[dict]   # [{id, url}] — url is a data: URI


@app.post("/api/figures")
async def save_figures(body: FiguresBody, request: Request):
    uid = current_uid(request)
    if not uid:
        return {"ok": True, "saved": 0}   # logged out → kept local-only, like state
    course = (body.courseId or "").strip()
    if not course:
        raise HTTPException(status_code=400, detail="courseId requis.")
    saved = await run_in_threadpool(fig_set, state_key(uid), course, body.figures)
    return {"ok": True, "saved": saved}


@app.get("/api/figures/{course_id}/{fig_id}")
async def get_figure(course_id: str, fig_id: str, request: Request):
    uid = current_uid(request)

    def _lookup():
        d = fig_get(state_key(uid), course_id, fig_id)
        if d is None and uid:   # fall back to the global slot (seed parity)
            d = fig_get("app", course_id, fig_id)
        return d

    data_uri = await run_in_threadpool(_lookup)
    if not data_uri:
        raise HTTPException(status_code=404, detail="Figure introuvable.")
    try:
        header, b64 = data_uri.split(",", 1)
        ctype = header.split(":", 1)[1].split(";", 1)[0] or "image/jpeg"
        raw = base64.b64decode(b64)
    except Exception:
        raise HTTPException(status_code=404, detail="Figure illisible.")
    return Response(content=raw, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


_MAX_UPLOAD = 50 * 1024 * 1024   # 50 MB hard limit
_VALID_PROVIDERS = {"gemini", "claude", "ollama"}


@app.post("/api/extract")
async def api_extract(request: Request, file: UploadFile = File(...)):
    rate_limit(request, "extract", 10, 60)
    data = await _read_capped(file, _MAX_UPLOAD, request)
    if not data:
        raise HTTPException(status_code=400, detail="Fichier vide.")
    if not (file.filename or "").lower().endswith(".pdf") and "pdf" not in (file.content_type or ""):
        raise HTTPException(status_code=400, detail="Seuls les fichiers PDF sont acceptés par cet extracteur.")
    if not data[:5].startswith(b"%PDF-"):   # magic bytes — don't trust the filename/type alone
        raise HTTPException(status_code=400, detail="Ce fichier n'est pas un PDF valide.")
    try:
        result = await run_in_threadpool(extract_pdf, data)
    except Exception as e:  # noqa: BLE001
        _log_err("extract", e)
        raise HTTPException(status_code=500, detail="Extraction impossible.")
    return JSONResponse(result)


class LLMRequest(BaseModel):
    system: str = ""
    prompt: str
    provider: str = "gemini"
    model: str | None = None
    images: list[dict] | None = None


_MAX_PROMPT_CHARS = 600_000   # ~150k tokens; generous for a full course PDF, but bounded
_MAX_IMAGES = 20


def _validate_llm(req: "LLMRequest") -> None:
    if req.provider not in _VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail=f"Provider invalide : {req.provider!r}. Valeurs acceptées : {sorted(_VALID_PROVIDERS)}")
    if len(req.prompt or "") + len(req.system or "") > _MAX_PROMPT_CHARS:
        raise HTTPException(status_code=413, detail="Requête trop volumineuse.")
    if req.images is not None and len(req.images) > _MAX_IMAGES:
        raise HTTPException(status_code=413, detail="Trop d'images dans la requête.")


@app.post("/api/llm")
async def api_llm(req: LLMRequest, request: Request):
    rate_limit(request, "llm", 20, 60)
    _validate_llm(req)
    try:
        text = await llm.complete(req.system, req.prompt, req.provider, req.model, req.images)
    except llm.LLMError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        _log_err("llm", e)
        raise HTTPException(status_code=500, detail="Erreur interne du moteur.")
    return {"text": text}


@app.post("/api/llm/stream")
async def api_llm_stream(req: LLMRequest, request: Request):
    """Server-Sent Events stream — yields text chunks as they arrive from the LLM."""
    rate_limit(request, "llm", 20, 60)
    _validate_llm(req)

    async def event_stream():
        try:
            async for chunk in llm.stream(req.system, req.prompt, req.provider, req.model, req.images):
                yield f"data: {json_module.dumps({'c': chunk})}\n\n"
        except llm.LLMError as e:
            yield f"data: {json_module.dumps({'error': str(e)})}\n\n"
        except Exception as e:  # noqa: BLE001
            _log_err("llm/stream", e)
            yield f"data: {json_module.dumps({'error': 'Erreur interne du moteur.'})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Static frontend (mounted LAST so /api/* routes win)
# ---------------------------------------------------------------------------
if WEB.is_dir():
    app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")


if __name__ == "__main__":
    # HOST defaults to localhost; set HOST=0.0.0.0 to expose on the LAN
    # (e.g. to test on a phone over the same Wi-Fi).
    uvicorn.run("server:app", host=os.environ.get("HOST", "127.0.0.1"),
                port=int(os.environ.get("PORT", "8000")), reload=False)
