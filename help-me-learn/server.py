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
import collections
import hashlib
import hmac
import json as json_module
import os
import pathlib
import secrets
import smtplib
import sqlite3
import threading
import time
from email.message import EmailMessage


def _log_err(context: str, exc: Exception) -> None:
    """Log the real error server-side; clients only ever see a generic message
    (so exception text never leaks paths / library internals)."""
    print(f"[error] {context}: {type(exc).__name__}: {exc}", flush=True)

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
# The connection is shared across threadpool workers. A single sqlite3
# connection is NOT safe for concurrent use, so every access is serialized
# through _db_lock. WAL + a busy timeout add resilience under load.
_db_lock = threading.RLock()
try:
    _db.execute("PRAGMA journal_mode=WAL")
    _db.execute("PRAGMA busy_timeout=5000")
except Exception as e:  # noqa: BLE001
    _log_err("sqlite pragma", e)
_db.execute("""
    CREATE TABLE IF NOT EXISTS kv (
        k  TEXT PRIMARY KEY,
        v  TEXT NOT NULL,
        ts TEXT DEFAULT (datetime('now'))
    )
""")
_db.commit()

def _db_get(key: str) -> str | None:
    with _db_lock:
        row = _db.execute("SELECT v FROM kv WHERE k = ?", (key,)).fetchone()
    return row[0] if row else None

def _db_set(key: str, value: str) -> None:
    with _db_lock:
        _db.execute(
            "INSERT OR REPLACE INTO kv (k, v, ts) VALUES (?, ?, datetime('now'))",
            (key, value),
        )
        _db.commit()

# Original course images (extracted from PDFs) live in their OWN table — NOT in
# the state blob — so the state stays small while the images persist and sync
# across devices. `owner` mirrors the state key ("app" or "app:<uid>").
# figures are keyed by (owner, course_id, fig_id): every course numbers its own
# figures from f1, so the course_id is REQUIRED to keep them apart — without it
# one course's f1 overwrites every other course's f1.
_fig_cols = [r[1] for r in _db.execute("PRAGMA table_info(figures)").fetchall()]
if _fig_cols and "course_id" not in _fig_cols:
    _db.execute("DROP TABLE figures")   # old unscoped rows are corrupted (collided) — start clean
_db.execute("""
    CREATE TABLE IF NOT EXISTS figures (
        owner     TEXT NOT NULL,
        course_id TEXT NOT NULL,
        fig_id    TEXT NOT NULL,
        data      TEXT NOT NULL,
        ts        TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (owner, course_id, fig_id)
    )
""")
_db.commit()

def _fig_get(owner: str, course_id: str, fig_id: str) -> str | None:
    with _db_lock:
        row = _db.execute(
            "SELECT data FROM figures WHERE owner = ? AND course_id = ? AND fig_id = ?",
            (owner, course_id, fig_id),
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
_db.execute("""
    CREATE TABLE IF NOT EXISTS reset_tokens (
        token   TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires INTEGER NOT NULL
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

_SESSION_DAYS = 60   # server-side session lifetime (matches the cookie max-age)
_SESSION_MODIFIER = f"-{_SESSION_DAYS} days"   # bound as a SQL parameter, never interpolated

def _user_by_email(email: str):
    with _db_lock:
        return _db.execute("SELECT id, email, pwhash FROM users WHERE email = ?", (email,)).fetchone()

def _create_user(email: str, password: str) -> int:
    with _db_lock:
        cur = _db.execute("INSERT INTO users (email, pwhash) VALUES (?, ?)", (email, _hash_pw(password)))
        _db.commit()
        return cur.lastrowid

def _purge_expired() -> None:
    """Opportunistic cleanup of stale sessions and reset tokens (called on login/
    register so the tables don't grow unbounded). Caller holds _db_lock."""
    _db.execute("DELETE FROM sessions WHERE created < datetime('now', ?)", (_SESSION_MODIFIER,))
    _db.execute("DELETE FROM reset_tokens WHERE expires < ?", (int(time.time()),))

def _new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with _db_lock:
        _db.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
        _purge_expired()
        _db.commit()
    return token

def _set_user_password(user_id: int, password: str) -> None:
    with _db_lock:
        _db.execute("UPDATE users SET pwhash = ? WHERE id = ?", (_hash_pw(password), user_id))
        _db.commit()

def _create_reset_token(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with _db_lock:
        _db.execute("INSERT INTO reset_tokens (token, user_id, expires) VALUES (?, ?, ?)",
                    (token, user_id, int(time.time()) + 3600))   # valid 1 hour
        _db.commit()
    return token

def _consume_reset_token(token: str):
    """Return the user_id for a valid token and delete it (one-time use), else None."""
    with _db_lock:
        row = _db.execute("SELECT user_id, expires FROM reset_tokens WHERE token = ?", (token,)).fetchone()
        if not row:
            return None
        _db.execute("DELETE FROM reset_tokens WHERE token = ?", (token,))
        _db.commit()
    return row[0] if row[1] >= int(time.time()) else None

def _send_reset_email(to_email: str, link: str) -> bool:
    """Send the reset link over SMTP (config via env). If SMTP isn't configured,
    log the link to the server console so a self-host admin can still relay it."""
    host = os.environ.get("SMTP_HOST")
    if not host:
        print(f"[auth] SMTP not configured — reset link for {to_email}: {link}", flush=True)
        return False
    msg = EmailMessage()
    msg["Subject"] = "Réinitialise ton mot de passe — Help me Learn"
    msg["From"] = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", "no-reply@" + host))
    msg["To"] = to_email
    msg.set_content(
        "Tu as demandé à réinitialiser ton mot de passe.\n\n"
        f"Ouvre ce lien (valable 1 heure) :\n{link}\n\n"
        "Si tu n'es pas à l'origine de cette demande, ignore cet email."
    )
    try:
        with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=20) as s:
            s.starttls()
            user = os.environ.get("SMTP_USER")
            if user:
                s.login(user, os.environ.get("SMTP_PASS", ""))
            s.send_message(msg)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[auth] reset email send failed: {e}", flush=True)
        return False

def _uid_for_token(token: str | None):
    if not token:
        return None
    with _db_lock:
        row = _db.execute(
            "SELECT user_id FROM sessions WHERE token = ? "
            "AND created >= datetime('now', ?)",
            (token, _SESSION_MODIFIER),
        ).fetchone()
    return row[0] if row else None

def _current_uid(request: Request):
    return _uid_for_token(request.cookies.get(COOKIE))

# Secure cookies in production (HTTPS). Local dev is plain HTTP on localhost,
# where a Secure cookie would never be sent — so gate it on DOMAIN being set
# (only the deployed stack sets DOMAIN). Override with COOKIE_SECURE=1/0.
_COOKIE_SECURE = (os.environ.get("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}
                  or bool(os.environ.get("DOMAIN", "").strip()))

def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax",
                        secure=_COOKIE_SECURE, max_age=60 * 60 * 24 * _SESSION_DAYS, path="/")


# ---------------------------------------------------------------------------
# Rate limiting — dependency-free, in-memory, per-client-IP sliding window.
# The server is public and the heavy endpoints (LLM/TTS/STT/extract/translate)
# burn paid API quota or CPU, so they MUST be throttled against anonymous abuse.
# Single-process only (matches the single-container deployment); for multiple
# workers move this to Redis.
# ---------------------------------------------------------------------------
_rl_lock = threading.Lock()
_rl_hits: dict[tuple, collections.deque] = collections.defaultdict(collections.deque)

def _client_ip(request: Request) -> str:
    # Behind Caddy the real IP is the first hop of X-Forwarded-For.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "?"

def _rate_limit(request: Request, bucket: str, limit: int, window: int) -> None:
    """Allow at most `limit` requests per `window` seconds per IP for `bucket`.
    Raises HTTP 429 (with Retry-After) when exceeded."""
    ip = _client_ip(request)
    now = time.time()
    cutoff = now - window
    key = (bucket, ip)
    with _rl_lock:
        dq = _rl_hits[key]
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= limit:
            retry = int(dq[0] + window - now) + 1
            raise HTTPException(status_code=429, detail="Trop de requêtes — réessaie dans un instant.",
                                headers={"Retry-After": str(max(1, retry))})
        dq.append(now)
        # Opportunistic sweep so idle IPs don't accumulate forever.
        if len(_rl_hits) > 4096:
            for k in [k for k, v in _rl_hits.items() if not v or v[-1] < cutoff]:
                _rl_hits.pop(k, None)

def _state_key(uid) -> str:
    return f"app:{uid}" if uid else "app"


async def _read_capped(upload: UploadFile, limit: int, request: Request) -> bytes:
    """Read an uploaded file into memory WITHOUT ever buffering more than `limit`.
    Rejects early on an oversized Content-Length, then reads in 1 MB chunks and
    aborts the moment the cap is exceeded — so a multi-GB POST can't OOM the box
    (the previous `await file.read()` buffered the whole upload before any check)."""
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
    _rate_limit(request, "translate", 20, 60)
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
    voice: str | None = None             # specific Piper voice model (else language default)
    segments: list[dict] | None = None   # [{text, lang, voice?}] → one gapless multi-voice clip


@app.post("/api/tts")
async def api_tts(body: TTSBody, request: Request):
    """Synthesize speech (Piper) → WAV bytes for background <audio> playback.
    Accepts `text`+`lang`, or `segments` (a sentence's fr/de parts) for one
    gapless clip. 503 when Piper/voices aren't set up — the frontend then
    falls back to Web Speech (foreground only)."""
    _rate_limit(request, "tts", 40, 60)
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
            else "Piper non installé : lance « pip install piper-tts »."
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
    _rate_limit(request, "stt", 20, 60)
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


class AuthBody(BaseModel):
    email: str
    password: str


_MIN_PASSWORD = 10

@app.post("/api/auth/register")
async def auth_register(body: AuthBody, request: Request, response: Response):
    _rate_limit(request, "register", 5, 3600)
    email = (body.email or "").strip().lower()
    if "@" not in email or "." not in email or len(email) < 5 or len(email) > 254:
        raise HTTPException(status_code=400, detail="Email invalide.")
    if len(body.password or "") < _MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Mot de passe trop court ({_MIN_PASSWORD} caractères minimum).")
    if await run_in_threadpool(_user_by_email, email):
        raise HTTPException(status_code=409, detail="Un compte existe déjà avec cet email.")
    uid = await run_in_threadpool(_create_user, email, body.password)
    _set_session_cookie(response, _new_session(uid))
    return {"email": email}


@app.post("/api/auth/login")
async def auth_login(body: AuthBody, request: Request, response: Response):
    _rate_limit(request, "login", 10, 300)
    row = await run_in_threadpool(_user_by_email, (body.email or "").strip().lower())
    if not row or not _verify_pw(body.password or "", row[2]):
        raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect.")
    _set_session_cookie(response, _new_session(row[0]))
    return {"email": row[1]}


class ForgotBody(BaseModel):
    email: str


@app.post("/api/auth/forgot")
async def auth_forgot(body: ForgotBody, request: Request):
    """Email a reset link if the account exists. Always returns ok — never
    reveals whether an email is registered."""
    _rate_limit(request, "forgot", 5, 3600)
    email = (body.email or "").strip().lower()
    row = await run_in_threadpool(_user_by_email, email)
    if row:
        token = await run_in_threadpool(_create_reset_token, row[0])
        domain = os.environ.get("DOMAIN")
        base = ("https://" + domain) if domain else str(request.base_url).rstrip("/")
        await run_in_threadpool(_send_reset_email, email, base + "/?reset=" + token)
    return {"ok": True}


class ResetBody(BaseModel):
    token: str
    password: str


@app.post("/api/auth/reset")
async def auth_reset(body: ResetBody, request: Request, response: Response):
    _rate_limit(request, "reset", 10, 3600)
    if len(body.password or "") < _MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Mot de passe trop court ({_MIN_PASSWORD} caractères minimum).")
    uid = await run_in_threadpool(_consume_reset_token, body.token or "")
    if not uid:
        raise HTTPException(status_code=400, detail="Lien invalide ou expiré. Redemande un email de réinitialisation.")
    await run_in_threadpool(_set_user_password, uid, body.password)
    _set_session_cookie(response, _new_session(uid))   # log them straight in
    with _db_lock:
        row = _db.execute("SELECT email FROM users WHERE id = ?", (uid,)).fetchone()
    return {"email": row[0] if row else None}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    tok = request.cookies.get(COOKIE)
    if tok:
        with _db_lock:
            _db.execute("DELETE FROM sessions WHERE token = ?", (tok,))
            _db.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    uid = _current_uid(request)
    if not uid:
        return JSONResponse(None)
    with _db_lock:
        row = _db.execute("SELECT email FROM users WHERE id = ?", (uid,)).fetchone()
    return {"email": row[0]} if row else JSONResponse(None)


class StateBody(BaseModel):
    data: str   # full JSON string: {chapters, currentId, theme}


@app.get("/api/state")
async def get_state(request: Request):
    uid = _current_uid(request)
    if not uid:
        # Logged out → no server state. Courses are private to an account, so a
        # public visitor (or a not-yet-signed-in device) sees nothing.
        return JSONResponse(None)
    raw = await run_in_threadpool(lambda: _db_get(_state_key(uid)))
    if raw is None:
        return JSONResponse(None)
    return JSONResponse(json_module.loads(raw))


@app.post("/api/state")
async def save_state(body: StateBody, request: Request):
    uid = _current_uid(request)
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
    await run_in_threadpool(lambda: _db_set(_state_key(uid), clean))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Course figures — the base64 images extracted from PDFs, stored out-of-band
# (see the `figures` table). Uploaded once at import; served as real images.
# ---------------------------------------------------------------------------
class FiguresBody(BaseModel):
    courseId: str
    figures: list[dict]   # [{id, url}] — url is a data: URI


@app.post("/api/figures")
async def save_figures(body: FiguresBody, request: Request):
    uid = _current_uid(request)
    if not uid:
        return {"ok": True, "saved": 0}   # logged out → kept local-only, like state
    owner = _state_key(uid)
    course = (body.courseId or "").strip()
    if not course:
        raise HTTPException(status_code=400, detail="courseId requis.")

    def _save() -> int:
        n = 0
        with _db_lock:
            for f in body.figures or []:
                fid = str((f or {}).get("id") or "").strip()
                url = (f or {}).get("url")
                if fid and isinstance(url, str) and url.startswith("data:"):
                    _db.execute(
                        "INSERT OR REPLACE INTO figures (owner, course_id, fig_id, data, ts) "
                        "VALUES (?, ?, ?, ?, datetime('now'))",
                        (owner, course, fid, url),
                    )
                    n += 1
            _db.commit()
        return n

    saved = await run_in_threadpool(_save)
    return {"ok": True, "saved": saved}


@app.get("/api/figures/{course_id}/{fig_id}")
async def get_figure(course_id: str, fig_id: str, request: Request):
    uid = _current_uid(request)

    def _lookup():
        d = _fig_get(_state_key(uid), course_id, fig_id)
        if d is None and uid:   # fall back to the global slot (seed parity)
            d = _fig_get("app", course_id, fig_id)
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
    _rate_limit(request, "extract", 10, 60)
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
    provider: str = "gemini"    # was "ollama" — corrected to current default
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
    _rate_limit(request, "llm", 20, 60)
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
    _rate_limit(request, "llm", 20, 60)
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
