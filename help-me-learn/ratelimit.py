"""
ratelimit.py — dependency-free, in-memory, per-client-IP sliding-window limiter.

The server is public and the heavy endpoints (LLM/TTS/STT/extract/translate) burn
paid API quota or CPU, so they MUST be throttled against anonymous abuse. Single
process only (matches the single-container deployment); for multiple workers move
this to Redis.

Usage from a route:
    from ratelimit import rate_limit
    rate_limit(request, "llm", 20, 60)   # ≤20 req / 60 s per IP for bucket "llm"
"""
from __future__ import annotations

import collections
import threading
import time

from fastapi import HTTPException, Request

_lock = threading.Lock()
_hits: dict[tuple, collections.deque] = collections.defaultdict(collections.deque)


def client_ip(request: Request) -> str:
    """Real client IP. Behind Caddy it's the first hop of X-Forwarded-For."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "?"


def rate_limit(request: Request, bucket: str, limit: int, window: int) -> None:
    """Allow at most `limit` requests per `window` seconds per IP for `bucket`.
    Raises HTTP 429 (with Retry-After) when exceeded."""
    ip = client_ip(request)
    now = time.time()
    cutoff = now - window
    key = (bucket, ip)
    with _lock:
        dq = _hits[key]
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= limit:
            retry = int(dq[0] + window - now) + 1
            raise HTTPException(status_code=429, detail="Trop de requêtes — réessaie dans un instant.",
                                headers={"Retry-After": str(max(1, retry))})
        dq.append(now)
        # Opportunistic sweep so idle IPs don't accumulate forever.
        if len(_hits) > 4096:
            for k in [k for k, v in _hits.items() if not v or v[-1] < cutoff]:
                _hits.pop(k, None)
