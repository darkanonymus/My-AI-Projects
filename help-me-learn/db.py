"""
db.py — SQLite persistence layer (the single owner of the DB connection).

One process-wide connection is shared across FastAPI threadpool workers. A single
sqlite3 connection is NOT safe for concurrent use, so EVERY access goes through
`lock`. WAL + a busy timeout add resilience under load.

Two stores live here:
  • kv       — one row per named state slot ("app" or "app:<uid>"): the course
               blobs (lessons/quiz/flashcards), minus the heavy base64 images.
  • figures  — the base64 course images, out-of-band so the kv blob stays small;
               keyed by (owner, course_id, fig_id).

Account tables (users/sessions/reset_tokens) are owned by auth.py, which imports
`conn`/`lock` from here.
"""
from __future__ import annotations

import os
import pathlib
import sqlite3
import threading

ROOT = pathlib.Path(__file__).parent
# DB path is configurable (HML_DB) so a container can persist it on a volume.
DB = pathlib.Path(os.environ.get("HML_DB", str(ROOT / "data.db")))
DB.parent.mkdir(parents=True, exist_ok=True)

conn = sqlite3.connect(str(DB), check_same_thread=False)
lock = threading.RLock()
try:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
except Exception as e:  # noqa: BLE001
    print(f"[error] sqlite pragma: {type(e).__name__}: {e}", flush=True)

# ---------------------------------------------------------------------------
# kv — named state slots
# ---------------------------------------------------------------------------
conn.execute("""
    CREATE TABLE IF NOT EXISTS kv (
        k  TEXT PRIMARY KEY,
        v  TEXT NOT NULL,
        ts TEXT DEFAULT (datetime('now'))
    )
""")
conn.commit()


def kv_get(key: str) -> str | None:
    with lock:
        row = conn.execute("SELECT v FROM kv WHERE k = ?", (key,)).fetchone()
    return row[0] if row else None


def kv_set(key: str, value: str) -> None:
    with lock:
        conn.execute(
            "INSERT OR REPLACE INTO kv (k, v, ts) VALUES (?, ?, datetime('now'))",
            (key, value),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# figures — original course images, stored out-of-band so the kv blob stays
# small while images persist and sync across devices. `owner` mirrors the state
# key ("app" or "app:<uid>"). Keyed by (owner, course_id, fig_id): every course
# numbers its figures from f1, so the course_id is REQUIRED to keep them apart —
# without it one course's f1 would overwrite every other course's f1.
# ---------------------------------------------------------------------------
_fig_cols = [r[1] for r in conn.execute("PRAGMA table_info(figures)").fetchall()]
if _fig_cols and "course_id" not in _fig_cols:
    conn.execute("DROP TABLE figures")   # old unscoped rows are corrupted (collided) — start clean
conn.execute("""
    CREATE TABLE IF NOT EXISTS figures (
        owner     TEXT NOT NULL,
        course_id TEXT NOT NULL,
        fig_id    TEXT NOT NULL,
        data      TEXT NOT NULL,
        ts        TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (owner, course_id, fig_id)
    )
""")
conn.commit()


def fig_get(owner: str, course_id: str, fig_id: str) -> str | None:
    with lock:
        row = conn.execute(
            "SELECT data FROM figures WHERE owner = ? AND course_id = ? AND fig_id = ?",
            (owner, course_id, fig_id),
        ).fetchone()
    return row[0] if row else None


def fig_set(owner: str, course_id: str, figures: list[dict]) -> int:
    """Upsert a batch of {id, url} figures (url = data: URI). Returns the count saved."""
    n = 0
    with lock:
        for f in figures or []:
            fid = str((f or {}).get("id") or "").strip()
            url = (f or {}).get("url")
            if fid and isinstance(url, str) and url.startswith("data:"):
                conn.execute(
                    "INSERT OR REPLACE INTO figures (owner, course_id, fig_id, data, ts) "
                    "VALUES (?, ?, ?, ?, datetime('now'))",
                    (owner, course_id, fid, url),
                )
                n += 1
        conn.commit()
    return n
