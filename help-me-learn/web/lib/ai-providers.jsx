/* ============================================================
   ai-providers.jsx — AI engine configuration + LLM call wrappers
   - getProvider/getOllamaModel/getClaudeModel/getGeminiModel...:
     which engine + model the browser remembers (localStorage)
   - getApiKey/setApiKey/hasPlatformAI/aiMode: legacy BYOK helpers
   - serverHealth: asks the local server what's available
   - callClaude / callClaudeStream: every lesson/quiz/flashcard
     request goes through these — POST /api/llm(/stream), routed
     server-side to Gemini or Claude
   ============================================================ */

/* ---- AI access: personal key (BYOK) OR platform AI ----
   getApiKey/setApiKey live in localStorage (per-browser, per-person).
   aiMode(): "key" = friend's own Claude key · "platform" = built-in AI · "none" = needs setup
*/
/* ---- AI access (LOCAL) ----
   Every call goes through the local server's /api/llm, which routes to either
   Ollama (offline, your installed model) or Claude (your key, kept in .env).
   The browser never holds an API key. The chosen engine + model live in
   localStorage so the choice persists per browser. */
function getProvider() { try { return localStorage.getItem("hml_provider") || "gemini"; } catch (e) { return "gemini"; } }
function setProvider(p) { try { localStorage.setItem("hml_provider", p); } catch (e) {} }
function getOllamaModel() { try { return localStorage.getItem("hml_ollama_model") || ""; } catch (e) { return ""; } }
function setOllamaModel(m) { try { if (m) localStorage.setItem("hml_ollama_model", m); else localStorage.removeItem("hml_ollama_model"); } catch (e) {} }
function getClaudeModel() { try { return localStorage.getItem("hml_claude_model") || ""; } catch (e) { return ""; } }
function setClaudeModel(m) { try { if (m) localStorage.setItem("hml_claude_model", m); else localStorage.removeItem("hml_claude_model"); } catch (e) {} }
function getGeminiModel() { try { return localStorage.getItem("hml_gemini_model") || "gemini-2.5-flash"; } catch (e) { return "gemini-2.5-flash"; } }
function setGeminiModel(m) { try { if (m) localStorage.setItem("hml_gemini_model", m); else localStorage.removeItem("hml_gemini_model"); } catch (e) {} }

/* kept for backward compatibility with older settings code (no longer used to call) */
function getApiKey() { try { return (localStorage.getItem("hml_api_key") || "").trim(); } catch (e) { return ""; } }
function setApiKey(k) { try { if (k && k.trim()) localStorage.setItem("hml_api_key", k.trim()); else localStorage.removeItem("hml_api_key"); } catch (e) {} }
function hasPlatformAI() { return true; }                 // the local server is always the engine
function aiMode() { const p = getProvider(); return p === "claude" ? "claude" : p === "gemini" ? "gemini" : "gemini"; }

/* ask the server what's available (Ollama up? which models? Claude key set?) */
async function serverHealth() {
  try { const r = await fetch("/api/health"); if (r.ok) return await r.json(); } catch (e) {}
  return null;
}

async function callClaude(userPrompt, systemExtra, images) {
  const langue = getLangue();
  const langLabel = LANG_LABELS[langue] || LANG_LABELS.fr;
  const sys = buildMethode(getNiveau(), langue) + (systemExtra ? "\n\n" + systemExtra : "");
  const provider = getProvider();
  let model;
  if (provider === "claude") model = getClaudeModel() || null;
  else if (provider === "gemini") model = getGeminiModel() || null;
  else model = getOllamaModel() || null;

  // Note: prompt builders already append buildLangTail() themselves for non-JSON sections.
  // callClaude only adds a prefix to reinforce — no suffix here to avoid doubling on JSON prompts.
  const langWrap = langue !== "fr"
    ? { pre: `[LANGUAGE: ${langLabel}]\n\n`, suf: "" }
    : { pre: "", suf: "" };

  const body = { system: sys, prompt: langWrap.pre + userPrompt + langWrap.suf, provider, model };
  if (images && images.length) body.images = images;

  let resp;
  try {
    resp = await fetch("/api/llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Le serveur local ne répond pas. Lance « python server.py » puis ouvre http://localhost:8000.");
  }
  if (!resp.ok) {
    let msg = "Erreur du moteur (" + resp.status + ").";
    try { const j = await resp.json(); if (j && j.detail) msg = j.detail; } catch (_) {}
    throw new Error(msg);
  }
  const data = await resp.json();
  return (data.text || "").trim();
}

async function callClaudeStream(userPrompt, systemExtra, onChunk, images) {
  const langue = getLangue();
  const sys = buildMethode(getNiveau(), langue) + (systemExtra ? "\n\n" + systemExtra : "");
  const provider = getProvider();
  const model = provider === "claude" ? getClaudeModel() || null
              : provider === "gemini" ? getGeminiModel() || null
              : getOllamaModel() || null;
  const pre = langue !== "fr" ? `[LANGUAGE: ${LANG_LABELS[langue] || LANG_LABELS.fr}]\n\n` : "";

  const body = { system: sys, prompt: pre + userPrompt, provider, model };
  if (images && images.length) body.images = images;

  let resp;
  try {
    resp = await fetch("/api/llm/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Le serveur local ne répond pas. Lance « python server.py » puis ouvre http://localhost:8000.");
  }
  if (!resp.ok) {
    let msg = "Erreur (" + resp.status + ").";
    try { const j = await resp.json(); if (j && j.detail) msg = j.detail; } catch (_) {}
    throw new Error(msg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split on double-newline (SSE event boundary)
      const parts = buffer.split("\n\n");
      buffer = parts.pop(); // last part may be incomplete
      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return fullText.trim();
          try {
            const obj = JSON.parse(data);
            if (obj.error) throw new Error(obj.error);
            const chunk = obj.c || "";
            if (chunk) { fullText += chunk; if (onChunk) onChunk(chunk); }
          } catch (e) {
            if (e.message && !e.message.startsWith("Unexpected token")) throw e;
          }
        }
      }
    }
  } catch (e) {
    if (fullText.trim().length > 10) return fullText.trim(); // partial is better than nothing
    throw e;
  }
  return fullText.trim();
}

