"""
llm.py — LLM router for Help me Learn (local).

Three engines, one interface:
  - "gemini"  → Gemini 2.5 Flash via OpenRouter (OpenAI-compatible, 65 k output tokens).
  - "claude"  → Anthropic's Claude API (needs an API key + internet). Strong pedagogy.
  - "ollama"  → [Deprecated] local model.

The frontend never talks to an LLM directly anymore: it POSTs {system, prompt,
provider, model} to /api/llm and this module does the rest. That keeps API keys
on the machine (never in the browser) and removes CORS issues.
"""

from __future__ import annotations
import os
import json
import httpx

# ---- configuration (env first, sensible defaults) ----
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

# Gemini via OpenRouter (OpenAI-compatible endpoint — no Google SDK needed)
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL   = os.environ.get("OPENROUTER_MODEL", "google/gemini-2.5-flash")
OPENROUTER_URL     = "https://openrouter.ai/api/v1/chat/completions"

# Ollama (deprecated, kept for compatibility)
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
DEFAULT_OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")

# generous timeouts: lessons are long, free tier might be slower
_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=600.0)


class LLMError(Exception):
    """Friendly, user-facing error (the message is shown in the UI in French)."""


# ---------------------------------------------------------------------------
# Availability probes — used by /api/health so the UI can show what's ready
# ---------------------------------------------------------------------------
async def ollama_status() -> dict:
    """[Deprecated] Is Ollama up? Which models are installed?"""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(4.0)) as c:
            r = await c.get(f"{OLLAMA_HOST}/api/tags")
            r.raise_for_status()
            data = r.json()
            models = [m.get("name") for m in data.get("models", []) if m.get("name")]
            return {"up": True, "models": models, "host": OLLAMA_HOST}
    except Exception as e:  # noqa: BLE001
        return {"up": False, "models": [], "host": OLLAMA_HOST, "error": str(e)}


def claude_status() -> dict:
    return {"configured": bool(ANTHROPIC_API_KEY), "model": ANTHROPIC_MODEL}


def gemini_status() -> dict:
    return {"configured": bool(OPENROUTER_API_KEY), "model": OPENROUTER_MODEL}


# ---------------------------------------------------------------------------
# Engine calls
# ---------------------------------------------------------------------------
async def _call_gemini(system: str, prompt: str, model: str | None) -> str:
    if not OPENROUTER_API_KEY:
        raise LLMError(
            "Aucune clé OpenRouter configurée. Ajoute OPENROUTER_API_KEY dans le fichier .env "
            "puis relance le serveur — ou utilise Claude."
        )

    model = (model or OPENROUTER_MODEL).strip()

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8000",
        "X-Title": "Help me Learn",
    }
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 16000,
        "top_p": 0.95,
    }

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(OPENROUTER_URL, headers=headers, json=payload)
    except httpx.ConnectError:
        raise LLMError("Connexion à OpenRouter impossible. Vérifie ta connexion internet.")
    except httpx.ReadTimeout:
        raise LLMError("OpenRouter met trop de temps à répondre. Réessaie dans quelques secondes.")

    if r.status_code == 401:
        raise LLMError("Clé API OpenRouter invalide. Vérifie OPENROUTER_API_KEY dans .env.")
    if r.status_code == 429:
        raise LLMError("Limite de l'API OpenRouter atteinte. Patiente ou utilise Claude.")
    if r.status_code >= 400:
        detail = ""
        try:
            data = r.json()
            if "error" in data:
                detail = data["error"].get("message", str(data["error"]))
        except Exception:  # noqa: BLE001
            detail = r.text[:300]
        raise LLMError(f"Erreur OpenRouter ({r.status_code}) : {detail}")

    data = r.json()
    try:
        content = data["choices"][0]["message"]["content"]
        return (content or "").strip()
    except (KeyError, IndexError, TypeError) as e:
        raise LLMError(f"Erreur lors du parsing de la réponse OpenRouter : {str(e)[:100]}")


async def _call_claude(system: str, prompt: str, model: str | None) -> str:
    if not ANTHROPIC_API_KEY:
        raise LLMError(
            "Aucune clé Claude configurée. Ajoute ANTHROPIC_API_KEY dans le fichier .env "
            "(voir README) puis relance le serveur — ou utilise Gemini (gratuit)."
        )
    headers = {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
    }
    payload = {
        "model": (model or ANTHROPIC_MODEL).strip(),
        "max_tokens": 4096,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(ANTHROPIC_URL, headers=headers, json=payload)
    except httpx.ConnectError:
        raise LLMError("Connexion à Claude impossible. Vérifie ta connexion internet.")
    if r.status_code == 401:
        raise LLMError("Clé API Claude invalide. Vérifie ANTHROPIC_API_KEY dans .env.")
    if r.status_code == 429:
        raise LLMError("Limite de l'API Claude atteinte. Patiente un instant puis réessaie.")
    if r.status_code >= 400:
        detail = ""
        try:
            detail = (r.json().get("error") or {}).get("message", "")
        except Exception:  # noqa: BLE001
            detail = r.text[:300]
        raise LLMError(f"Requête refusée par Claude ({r.status_code}) : {detail}")
    data = r.json()
    parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    return "".join(parts).strip()


async def _call_ollama(system: str, prompt: str, model: str | None) -> str:
    """[Deprecated] Use Gemini instead."""
    model = (model or DEFAULT_OLLAMA_MODEL).strip()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": 8192},
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(f"{OLLAMA_HOST}/api/chat", json=payload)
    except httpx.ConnectError:
        raise LLMError(
            "Ollama n'est pas accessible (déprécié). Utilise plutôt Gemini (gratuit, meilleur) "
            f"ou configure Claude."
        )
    except httpx.ReadTimeout:
        raise LLMError("Ollama met trop de temps à répondre. Utilise Gemini ou Claude à la place.")
    if r.status_code == 404:
        raise LLMError(
            f"Le modèle « {model} » n'est pas installé dans Ollama (déprécié). "
            f"Utilise Gemini (gratuit) ou Claude."
        )
    if r.status_code >= 400:
        raise LLMError(f"Erreur d'Ollama ({r.status_code}). Utilise Gemini ou Claude : {r.text[:300]}")
    data = r.json()
    msg = (data.get("message") or {}).get("content", "")
    return (msg or "").strip()


async def complete(system: str, prompt: str, provider: str = "gemini", model: str | None = None) -> str:
    """Single entry point used by the API layer."""
    provider = (provider or "gemini").lower()
    if provider == "claude":
        return await _call_claude(system, prompt, model)
    if provider == "gemini":
        return await _call_gemini(system, prompt, model)
    if provider == "ollama":
        return await _call_ollama(system, prompt, model)
    raise LLMError(f"Moteur inconnu : {provider!r} (attendu « gemini », « claude » ou « ollama »).")


# ---------------------------------------------------------------------------
# Streaming generators (SSE — yields text chunks)
# ---------------------------------------------------------------------------

async def _stream_openrouter(system: str, prompt: str, model: str | None):
    """Yield text chunks from OpenRouter (OpenAI-compatible SSE)."""
    if not OPENROUTER_API_KEY:
        raise LLMError("Aucune clé OpenRouter configurée. Ajoute OPENROUTER_API_KEY dans .env.")
    model = (model or OPENROUTER_MODEL).strip()
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8000",
        "X-Title": "Help me Learn",
    }
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model, "messages": messages,
        "temperature": 0.2, "max_tokens": 65536, "stream": True,
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            async with c.stream("POST", OPENROUTER_URL, headers=headers, json=payload) as r:
                if r.status_code == 401:
                    raise LLMError("Clé OpenRouter invalide. Vérifie OPENROUTER_API_KEY dans .env.")
                if r.status_code == 429:
                    raise LLMError("Limite OpenRouter atteinte. Patiente ou utilise Claude.")
                if r.status_code >= 400:
                    raise LLMError(f"Erreur OpenRouter ({r.status_code}).")
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        return
                    try:
                        obj = json.loads(data)
                        content = (obj.get("choices") or [{}])[0].get("delta", {}).get("content", "")
                        if content:
                            yield content
                    except json.JSONDecodeError:
                        continue
    except (httpx.ConnectError, httpx.ReadTimeout) as exc:
        raise LLMError(f"Connexion OpenRouter impossible : {exc}") from exc


async def _stream_claude(system: str, prompt: str, model: str | None):
    """Yield text chunks from Anthropic Claude streaming API."""
    if not ANTHROPIC_API_KEY:
        raise LLMError("Aucune clé Claude configurée. Ajoute ANTHROPIC_API_KEY dans .env.")
    headers = {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
    }
    payload = {
        "model": (model or ANTHROPIC_MODEL).strip(),
        "max_tokens": 4096,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            async with c.stream("POST", ANTHROPIC_URL, headers=headers, json=payload) as r:
                if r.status_code == 401:
                    raise LLMError("Clé Claude invalide. Vérifie ANTHROPIC_API_KEY dans .env.")
                if r.status_code == 429:
                    raise LLMError("Limite Claude atteinte. Patiente un instant.")
                if r.status_code >= 400:
                    raise LLMError(f"Erreur Claude ({r.status_code}).")
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    try:
                        obj = json.loads(data)
                        if obj.get("type") == "content_block_delta":
                            text = obj.get("delta", {}).get("text", "")
                            if text:
                                yield text
                        elif obj.get("type") == "message_stop":
                            return
                    except json.JSONDecodeError:
                        continue
    except (httpx.ConnectError, httpx.ReadTimeout) as exc:
        raise LLMError(f"Connexion Claude impossible : {exc}") from exc


async def stream(system: str, prompt: str, provider: str = "gemini", model: str | None = None):
    """Streaming entry point — async generator yielding text chunks."""
    provider = (provider or "gemini").lower()
    if provider == "gemini":
        async for chunk in _stream_openrouter(system, prompt, model):
            yield chunk
    elif provider == "claude":
        async for chunk in _stream_claude(system, prompt, model):
            yield chunk
    else:
        # Ollama: no streaming support — yield full response as single chunk
        text = await _call_ollama(system, prompt, model)
        if text:
            yield text
