"""
auth.py — optional accounts so courses follow you across devices.

Owns the account tables (users / sessions / reset_tokens) and everything about
identity: PBKDF2 password hashing, session cookies, one-time reset tokens (with
SMTP email), and the /api/auth/* routes (exposed as `router`). Logged out = the
legacy shared/global state; logged in = your own per-user state slot.

`current_uid(request)` and `state_key(uid)` are imported by server.py so the
content routes (state, figures) can scope data to the signed-in user.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import smtplib
import time
from email.message import EmailMessage

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from db import conn, lock
from ratelimit import rate_limit

# ---------------------------------------------------------------------------
# Account tables (this module owns them; the connection lives in db.py)
# ---------------------------------------------------------------------------
conn.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        email   TEXT UNIQUE NOT NULL,
        pwhash  TEXT NOT NULL,
        created TEXT DEFAULT (datetime('now'))
    )
""")
conn.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token   TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created TEXT DEFAULT (datetime('now'))
    )
""")
conn.execute("""
    CREATE TABLE IF NOT EXISTS reset_tokens (
        token   TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires INTEGER NOT NULL
    )
""")
conn.commit()

COOKIE = "hml_session"
_PBKDF_ITERS = 200_000
_SESSION_DAYS = 60   # server-side session lifetime (matches the cookie max-age)
_SESSION_MODIFIER = f"-{_SESSION_DAYS} days"   # bound as a SQL parameter, never interpolated
_MIN_PASSWORD = 10

# Secure cookies in production (HTTPS). Local dev is plain HTTP on localhost,
# where a Secure cookie would never be sent — so gate it on DOMAIN being set
# (only the deployed stack sets DOMAIN). Override with COOKIE_SECURE=1/0.
_COOKIE_SECURE = (os.environ.get("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}
                  or bool(os.environ.get("DOMAIN", "").strip()))


def state_key(uid) -> str:
    return f"app:{uid}" if uid else "app"


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# Users / sessions / reset tokens (all hold `lock` while touching the connection)
# ---------------------------------------------------------------------------
def _user_by_email(email: str):
    with lock:
        return conn.execute("SELECT id, email, pwhash FROM users WHERE email = ?", (email,)).fetchone()


def _create_user(email: str, password: str) -> int:
    with lock:
        cur = conn.execute("INSERT INTO users (email, pwhash) VALUES (?, ?)", (email, _hash_pw(password)))
        conn.commit()
        return cur.lastrowid


def _purge_expired() -> None:
    """Opportunistic cleanup of stale sessions and reset tokens (called on login/
    register so the tables don't grow unbounded). Caller holds `lock`."""
    conn.execute("DELETE FROM sessions WHERE created < datetime('now', ?)", (_SESSION_MODIFIER,))
    conn.execute("DELETE FROM reset_tokens WHERE expires < ?", (int(time.time()),))


def _new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with lock:
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
        _purge_expired()
        conn.commit()
    return token


def _set_user_password(user_id: int, password: str) -> None:
    with lock:
        conn.execute("UPDATE users SET pwhash = ? WHERE id = ?", (_hash_pw(password), user_id))
        conn.commit()


def _create_reset_token(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with lock:
        conn.execute("INSERT INTO reset_tokens (token, user_id, expires) VALUES (?, ?, ?)",
                     (token, user_id, int(time.time()) + 3600))   # valid 1 hour
        conn.commit()
    return token


def _consume_reset_token(token: str):
    """Return the user_id for a valid token and delete it (one-time use), else None."""
    with lock:
        row = conn.execute("SELECT user_id, expires FROM reset_tokens WHERE token = ?", (token,)).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM reset_tokens WHERE token = ?", (token,))
        conn.commit()
    return row[0] if row[1] >= int(time.time()) else None


def _email_for(uid: int):
    with lock:
        row = conn.execute("SELECT email FROM users WHERE id = ?", (uid,)).fetchone()
    return row[0] if row else None


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
    with lock:
        row = conn.execute(
            "SELECT user_id FROM sessions WHERE token = ? AND created >= datetime('now', ?)",
            (token, _SESSION_MODIFIER),
        ).fetchone()
    return row[0] if row else None


def current_uid(request: Request):
    """The signed-in user's id, or None. Imported by server.py content routes."""
    return _uid_for_token(request.cookies.get(COOKIE))


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax",
                        secure=_COOKIE_SECURE, max_age=60 * 60 * 24 * _SESSION_DAYS, path="/")


# ---------------------------------------------------------------------------
# Routes — mounted at /api/auth/* by server.py via app.include_router(router)
# ---------------------------------------------------------------------------
router = APIRouter(prefix="/api/auth")


class AuthBody(BaseModel):
    email: str
    password: str


class ForgotBody(BaseModel):
    email: str


class ResetBody(BaseModel):
    token: str
    password: str


@router.post("/register")
async def register(body: AuthBody, request: Request, response: Response):
    rate_limit(request, "register", 5, 3600)
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


@router.post("/login")
async def login(body: AuthBody, request: Request, response: Response):
    rate_limit(request, "login", 10, 300)
    row = await run_in_threadpool(_user_by_email, (body.email or "").strip().lower())
    if not row or not _verify_pw(body.password or "", row[2]):
        raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect.")
    _set_session_cookie(response, _new_session(row[0]))
    return {"email": row[1]}


@router.post("/forgot")
async def forgot(body: ForgotBody, request: Request):
    """Email a reset link if the account exists. Always returns ok — never
    reveals whether an email is registered."""
    rate_limit(request, "forgot", 5, 3600)
    email = (body.email or "").strip().lower()
    row = await run_in_threadpool(_user_by_email, email)
    if row:
        token = await run_in_threadpool(_create_reset_token, row[0])
        domain = os.environ.get("DOMAIN")
        base = ("https://" + domain) if domain else str(request.base_url).rstrip("/")
        await run_in_threadpool(_send_reset_email, email, base + "/?reset=" + token)
    return {"ok": True}


@router.post("/reset")
async def reset(body: ResetBody, request: Request, response: Response):
    rate_limit(request, "reset", 10, 3600)
    if len(body.password or "") < _MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Mot de passe trop court ({_MIN_PASSWORD} caractères minimum).")
    uid = await run_in_threadpool(_consume_reset_token, body.token or "")
    if not uid:
        raise HTTPException(status_code=400, detail="Lien invalide ou expiré. Redemande un email de réinitialisation.")
    await run_in_threadpool(_set_user_password, uid, body.password)
    _set_session_cookie(response, _new_session(uid))   # log them straight in
    return {"email": await run_in_threadpool(_email_for, uid)}


@router.post("/logout")
async def logout(request: Request, response: Response):
    tok = request.cookies.get(COOKIE)
    if tok:
        with lock:
            conn.execute("DELETE FROM sessions WHERE token = ?", (tok,))
            conn.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
async def me(request: Request):
    uid = current_uid(request)
    if not uid:
        return JSONResponse(None)
    email = await run_in_threadpool(_email_for, uid)
    return {"email": email} if email else JSONResponse(None)
