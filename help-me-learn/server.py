"""
server.py — local web server for Help me Learn.

Run it, open http://localhost:8000, and the app works entirely on your machine:
  • PDF extraction      → pdf_oxide + pypdfium2 (this server)
  • Lessons / quizzes   → Ollama (local) or Claude (your key), your choice in the UI

Start:
    uvicorn server:app --reload --port 8000
or simply:
    python server.py
"""

from __future__ import annotations
import base64
import hashlib
import hmac
import json as json_module
import os
import pathlib
import secrets
import sqlite3

# Load .env BEFORE importing llm, so the API key / model are captured on import.
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

ROOT = pathlib.Path(__file__).parent
WEB  = ROOT / "web"
# DB path is configurable (HML_DB) so a container can persist it on a volume.
DB   = pathlib.Path(os.environ.get("HML_DB", str(ROOT / "data.db")))
DB.parent.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# SQLite — single kv table, one row per named state slot
# ---------------------------------------------------------------------------
_db = sqlite3.connect(str(DB), check_same_thread=False)
_db.execute("""
    CREATE TABLE IF NOT EXISTS kv (
        k  TEXT PRIMARY KEY,
        v  TEXT NOT NULL,
        ts TEXT DEFAULT (datetime('now'))
    )
""")
_db.commit()

def _db_get(key: str) -> str | None:
    row = _db.execute("SELECT v FROM kv WHERE k = ?", (key,)).fetchone()
    return row[0] if row else None

def _db_set(key: str, value: str) -> None:
    _db.execute(
        "INSERT OR REPLACE INTO kv (k, v, ts) VALUES (?, ?, datetime('now'))",
        (key, value),
    )
    _db.commit()

# Original course images (extracted from PDFs) live in their OWN table — NOT in
# the state blob — so the state stays small while the images persist and sync
# across devices. `owner` mirrors the state key ("app" or "app:<uid>").
_db.execute("""
    CREATE TABLE IF NOT EXISTS figures (
        owner   TEXT NOT NULL,
        fig_id  TEXT NOT NULL,
        data    TEXT NOT NULL,
        ts      TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (owner, fig_id)
    )
""")
_db.commit()

def _fig_get(owner: str, fig_id: str) -> str | None:
    row = _db.execute(
        "SELECT data FROM figures WHERE owner = ? AND fig_id = ?", (owner, fig_id)
    ).fetchone()
    return row[0] if row else None

# ---------------------------------------------------------------------------
# Accounts — optional login so courses follow you across devices.
# Logged out = the legacy shared/global state (unchanged). Logged in = your own
# per-user state, seeded once from the global state so existing courses carry over.
# ---------------------------------------------------------------------------
_db.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        email   TEXT UNIQUE NOT NULL,
        pwhash  TEXT NOT NULL,
        created TEXT DEFAULT (datetime('now'))
    )
""")
_db.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token   TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created TEXT DEFAULT (datetime('now'))
    )
""")
_db.commit()

COOKIE = "hml_session"
_PBKDF_ITERS = 200_000

def _hash_pw(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), _PBKDF_ITERS)
    return f"{salt}${dk.hex()}"

def _verify_pw(password: str, stored: str) -> bool:
    try:
        salt, _ = stored.split("$", 1)
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(_hash_pw(password, salt), stored)

def _user_by_email(email: str):
    return _db.execute("SELECT id, email, pwhash FROM users WHERE email = ?", (email,)).fetchone()

def _create_user(email: str, password: str) -> int:
    cur = _db.execute("INSERT INTO users (email, pwhash) VALUES (?, ?)", (email, _hash_pw(password)))
    _db.commit()
    return cur.lastrowid

def _new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    _db.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    _db.commit()
    return token

def _uid_for_token(token: str | None):
    if not token:
        return None
    row = _db.execute("SELECT user_id FROM sessions WHERE token = ?", (token,)).fetchone()
    return row[0] if row else None

def _current_uid(request: Request):
    return _uid_for_token(request.cookies.get(COOKIE))

def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax",
                        max_age=60 * 60 * 24 * 60, path="/")

def _state_key(uid) -> str:
    return f"app:{uid}" if uid else "app"

app = FastAPI(title="Help me Learn — local")


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
async def api_translate(body: TranslateBody):
    """Translate a batch of course strings offline (Argos), preserving math /
    code / <<terms>> / markdown. 503 when Argos isn't installed."""
    if body.source == body.target:
        return {"translations": body.texts}
    if not translate_mod.available():
        raise HTTPException(status_code=503, detail="Traduction hors-ligne indisponible : lance « pip install argostranslate ».")
    try:
        out = await run_in_threadpool(translate_mod.translate_batch, body.texts, body.source, body.target)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Traduction impossible : {e}")
    return {"translations": out}


class TTSBody(BaseModel):
    text: str | None = None
    lang: str = "fr"
    voice: str | None = None             # specific Piper voice model (else language default)
    segments: list[dict] | None = None   # [{text, lang, voice?}] → one gapless multi-voice clip


@app.post("/api/tts")
async def api_tts(body: TTSBody):
    """Synthesize speech (Piper) → WAV bytes for background <audio> playback.
    Accepts `text`+`lang`, or `segments` (a sentence's fr/de parts) for one
    gapless clip. 503 when Piper/voices aren't set up — the frontend then
    falls back to Web Speech (foreground only)."""
    if not body.segments and not (body.text or "").strip():
        raise HTTPException(status_code=400, detail="Texte vide.")
    if not tts.available():
        st = tts.status()
        hint = (
            "Voix Piper absentes : lance « python scripts/download_voices.py »."
            if st.get("piper_installed")
            else "Piper non installé : lance « pip install piper-tts »."
        )
        raise HTTPException(status_code=503, detail=hint)
    try:
        if body.segments:
            audio = await run_in_threadpool(tts.synthesize_segments, body.segments)
        else:
            audio = await run_in_threadpool(tts.synthesize, body.text, body.lang, body.voice)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Synthèse vocale impossible : {e}")
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.post("/api/stt")
async def api_stt(audio: UploadFile = File(...), lang: str = "fr"):
    """Transcribe a recorded question (Whisper) → {text}. Cross-platform
    (incl. iOS) replacement for the browser's SpeechRecognition. 503 when
    faster-whisper isn't installed — the frontend then falls back to Web Speech."""
    if not stt.available():
        raise HTTPException(status_code=503, detail="Transcription indisponible : lance « pip install faster-whisper ».")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Audio vide.")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Enregistrement trop long.")
    suffix = "." + ((audio.filename or "q.webm").rsplit(".", 1)[-1] or "webm")
    try:
        text = await run_in_threadpool(stt.transcribe, data, lang, suffix)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Transcription impossible : {e}")
    return {"text": text}


class AuthBody(BaseModel):
    email: str
    password: str


@app.post("/api/auth/register")
async def auth_register(body: AuthBody, response: Response):
    email = (body.email or "").strip().lower()
    if "@" not in email or "." not in email or len(email) < 5:
        raise HTTPException(status_code=400, detail="Email invalide.")
    if len(body.password or "") < 6:
        raise HTTPException(status_code=400, detail="Mot de passe trop court (6 caractères minimum).")
    if await run_in_threadpool(_user_by_email, email):
        raise HTTPException(status_code=409, detail="Un compte existe déjà avec cet email.")
    uid = await run_in_threadpool(_create_user, email, body.password)
    _set_session_cookie(response, _new_session(uid))
    return {"email": email}


@app.post("/api/auth/login")
async def auth_login(body: AuthBody, response: Response):
    row = await run_in_threadpool(_user_by_email, (body.email or "").strip().lower())
    if not row or not _verify_pw(body.password or "", row[2]):
        raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect.")
    _set_session_cookie(response, _new_session(row[0]))
    return {"email": row[1]}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    tok = request.cookies.get(COOKIE)
    if tok:
        _db.execute("DELETE FROM sessions WHERE token = ?", (tok,))
        _db.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    uid = _current_uid(request)
    if not uid:
        return JSONResponse(None)
    row = _db.execute("SELECT email FROM users WHERE id = ?", (uid,)).fetchone()
    return {"email": row[0]} if row else JSONResponse(None)


class StateBody(BaseModel):
    data: str   # full JSON string: {chapters, currentId, theme}


@app.get("/api/state")
async def get_state(request: Request):
    uid = _current_uid(request)
    raw = await run_in_threadpool(lambda: _db_get(_state_key(uid)))
    if raw is None and uid:
        # first time for this user → seed from the legacy global state (read-only)
        raw = await run_in_threadpool(lambda: _db_get("app"))
    if raw is None:
        return JSONResponse(None)
    return JSONResponse(json_module.loads(raw))


@app.post("/api/state")
async def save_state(body: StateBody, request: Request):
    uid = _current_uid(request)
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
    await run_in_threadpool(lambda: _db_set(_state_key(uid), clean))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Course figures — the base64 images extracted from PDFs, stored out-of-band
# (see the `figures` table). Uploaded once at import; served as real images.
# ---------------------------------------------------------------------------
class FiguresBody(BaseModel):
    figures: list[dict]   # [{id, url}] — url is a data: URI


@app.post("/api/figures")
async def save_figures(body: FiguresBody, request: Request):
    owner = _state_key(_current_uid(request))

    def _save() -> int:
        n = 0
        for f in body.figures or []:
            fid = str((f or {}).get("id") or "").strip()
            url = (f or {}).get("url")
            if fid and isinstance(url, str) and url.startswith("data:"):
                _db.execute(
                    "INSERT OR REPLACE INTO figures (owner, fig_id, data, ts) "
                    "VALUES (?, ?, ?, datetime('now'))",
                    (owner, fid, url),
                )
                n += 1
        _db.commit()
        return n

    saved = await run_in_threadpool(_save)
    return {"ok": True, "saved": saved}


@app.get("/api/figures")
async def list_figures(request: Request):
    """Ids the current user has images for (logged-in users also see the global
    set, mirroring how state seeds from the legacy global slot)."""
    uid = _current_uid(request)
    owner = _state_key(uid)

    def _ids():
        ids = {r[0] for r in _db.execute("SELECT fig_id FROM figures WHERE owner = ?", (owner,)).fetchall()}
        if uid:
            ids.update(r[0] for r in _db.execute("SELECT fig_id FROM figures WHERE owner = 'app'").fetchall())
        return sorted(ids)

    return {"ids": await run_in_threadpool(_ids)}


@app.get("/api/figures/{fig_id}")
async def get_figure(fig_id: str, request: Request):
    uid = _current_uid(request)

    def _lookup():
        d = _fig_get(_state_key(uid), fig_id)
        if d is None and uid:   # fall back to the global slot (seed parity)
            d = _fig_get("app", fig_id)
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
async def api_extract(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Fichier vide.")
    if len(data) > _MAX_UPLOAD:
        raise HTTPException(status_code=413, detail=f"Fichier trop volumineux ({len(data)//1024//1024} Mo). Maximum : 50 Mo.")
    if not (file.filename or "").lower().endswith(".pdf") and "pdf" not in (file.content_type or ""):
        raise HTTPException(status_code=400, detail="Seuls les fichiers PDF sont acceptés par cet extracteur.")
    try:
        result = await run_in_threadpool(extract_pdf, data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Extraction impossible : {e}")
    return JSONResponse(result)


class LLMRequest(BaseModel):
    system: str = ""
    prompt: str
    provider: str = "gemini"    # was "ollama" — corrected to current default
    model: str | None = None
    images: list[dict] | None = None


@app.post("/api/llm")
async def api_llm(req: LLMRequest):
    if req.provider not in _VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail=f"Provider invalide : {req.provider!r}. Valeurs acceptées : {sorted(_VALID_PROVIDERS)}")
    try:
        text = await llm.complete(req.system, req.prompt, req.provider, req.model, req.images)
    except llm.LLMError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Erreur du moteur : {e}")
    return {"text": text}


@app.post("/api/llm/stream")
async def api_llm_stream(req: LLMRequest):
    """Server-Sent Events stream — yields text chunks as they arrive from the LLM."""
    if req.provider not in _VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail=f"Provider invalide : {req.provider!r}")

    async def event_stream():
        try:
            async for chunk in llm.stream(req.system, req.prompt, req.provider, req.model, req.images):
                yield f"data: {json_module.dumps({'c': chunk})}\n\n"
        except llm.LLMError as e:
            yield f"data: {json_module.dumps({'error': str(e)})}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json_module.dumps({'error': str(e)})}\n\n"
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
