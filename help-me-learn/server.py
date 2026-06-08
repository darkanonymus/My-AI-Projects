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
import json as json_module
import os
import pathlib
import sqlite3

# Load .env BEFORE importing llm, so the API key / model are captured on import.
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:  # noqa: BLE001
    pass

import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import llm
from extract import extract_pdf

ROOT = pathlib.Path(__file__).parent
WEB  = ROOT / "web"
DB   = ROOT / "data.db"

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
        "default_provider": os.environ.get("DEFAULT_PROVIDER", "gemini"),
    }


class StateBody(BaseModel):
    data: str   # full JSON string: {chapters, currentId, theme}


@app.get("/api/state")
async def get_state():
    raw = await run_in_threadpool(lambda: _db_get("app"))
    if raw is None:
        return JSONResponse(None)
    return JSONResponse(json_module.loads(raw))


@app.post("/api/state")
async def save_state(body: StateBody):
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
    await run_in_threadpool(lambda: _db_set("app", clean))
    return {"ok": True}


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
    uvicorn.run("server:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), reload=False)
