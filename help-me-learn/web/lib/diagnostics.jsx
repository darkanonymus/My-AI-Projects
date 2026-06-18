/* ============================================================
   lib/diagnostics.jsx — client-side diagnostics ("où ça a coincé")
   Loaded FIRST so it can capture errors from the whole session.
   - window.HMLog: ring buffer (+ localStorage), auto-captures API
     calls (status + latency), JS errors, and unhandled rejections.
   - DiagnosticsModal: view / filter / copy / export / clear the log.
   ============================================================ */
(function () {
  const KEY = "hml.diaglog";
  const MAX = 300;
  let buf = [];
  try { const raw = localStorage.getItem(KEY); if (raw) buf = JSON.parse(raw) || []; } catch (_) {}

  let saveTimer = null;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { localStorage.setItem(KEY, JSON.stringify(buf.slice(-MAX))); } catch (_) {}
    }, 400);
  }
  const subs = new Set();
  function emit() { subs.forEach(fn => { try { fn(); } catch (_) {} }); }
  function safeJson(o) { try { return JSON.stringify(o); } catch (_) { return String(o); } }

  function add(level, event, detail) {
    const e = { t: Date.now(), level, event, detail: detail == null ? "" : (typeof detail === "string" ? detail : safeJson(detail)) };
    buf.push(e);
    if (buf.length > MAX + 50) buf = buf.slice(-MAX);
    persist(); emit();
    return e;
  }

  const HMLog = {
    log: (event, detail) => add("info", event, detail),
    warn: (event, detail) => add("warn", event, detail),
    error: (event, detail) => add("error", event, detail),
    all: () => buf.slice(),
    errorCount: () => buf.reduce((n, e) => n + (e.level === "error" ? 1 : 0), 0),
    clear: () => { buf = []; persist(); emit(); },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    asText: () => buf.map(e => `[${new Date(e.t).toISOString()}] ${e.level.toUpperCase().padEnd(5)} ${e.event}${e.detail ? "  —  " + e.detail : ""}`).join("\n"),
  };
  window.HMLog = HMLog;

  // ---- capture uncaught errors ----
  window.addEventListener("error", (ev) => {
    if (ev && ev.message) {
      const where = ev.filename ? " @ " + String(ev.filename).split("/").pop() + ":" + ev.lineno : "";
      add("error", "js.error", ev.message + where);
    }
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev && ev.reason;
    add("error", "js.unhandledRejection", (r && (r.message || ("" + r))) || safeJson(r));
  });

  // ---- wrap fetch to record API outcomes + timing ----
  const _fetch = window.fetch;
  if (typeof _fetch === "function" && !_fetch.__hmlogged) {
    function shortUrl(u) { try { return new URL(u, location.href).pathname; } catch (_) { return u; } }
    const wrapped = async function (input, init) {
      const url = (typeof input === "string" ? input : (input && input.url)) || "";
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const isApi = /\/api\//.test(url);
      const quiet = /\/api\/(state|health)/.test(url); // autosave + health polling are frequent — only log if they fail
      let extra = "";
      if (isApi && /\/api\/llm/.test(url) && init && typeof init.body === "string") {
        try { const b = JSON.parse(init.body); extra = " · " + (b.provider || "?") + (b.model ? "/" + b.model : ""); } catch (_) {}
      }
      const t0 = (window.performance && performance.now()) || Date.now();
      try {
        const res = await _fetch.apply(this, arguments);
        if (isApi && (!quiet || !res.ok)) {
          const ms = Math.round(((window.performance && performance.now()) || Date.now()) - t0);
          add(res.ok ? "info" : "error", method + " " + shortUrl(url), "HTTP " + res.status + extra + " · " + ms + "ms");
        }
        return res;
      } catch (e) {
        if (isApi) {
          const ms = Math.round(((window.performance && performance.now()) || Date.now()) - t0);
          add("error", method + " " + shortUrl(url), "réseau injoignable : " + ((e && e.message) || e) + extra + " · " + ms + "ms");
        }
        throw e;
      }
    };
    wrapped.__hmlogged = true;
    window.fetch = wrapped;
  }

  HMLog.log("session.start", "navigateur prêt · " + (navigator.language || ""));
})();

/* ---- Diagnostics panel ---- */
const TT = (k, f) => { const v = window.ui ? window.ui(k) : null; return (v && v !== k) ? v : f; };
function DiagnosticsModal({ open, onClose }) {
  const { useState, useEffect } = React;
  const [, force] = useState(0);
  const [filter, setFilter] = useState("all");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    return window.HMLog.subscribe(() => force(n => n + 1));
  }, [open]);

  if (!open) return null;
  const I = window.Icon;
  const allEntries = window.HMLog.all();
  const entries = allEntries.slice().reverse().filter(e => filter === "all" || e.level === "error");
  const errCount = window.HMLog.errorCount();

  function copyAll() {
    const text = window.HMLog.asText();
    try {
      navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
    } catch (_) {}
  }
  function exportFile() {
    const blob = new Blob([window.HMLog.asText()], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "help-me-learn-diagnostics-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="card modal-panel modal-panel--tall fade-in" onClick={e => e.stopPropagation()} style={{ width: "min(680px, 100%)" }}>
        <div className="accent-bar" />
        <div className="modal-body">
          <div className="modal-head">
            <div className="tile-icon"><I name="warn" size={18} /></div>
            <h2>{TT("diagTitle", "Diagnostics")}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label={TT("raClose", "Fermer")}><I name="x" size={18} /></button>
          </div>
          <p className="soft" style={{ fontSize: "var(--fs-small)", margin: "0 0 var(--space-4)", lineHeight: 1.55 }}>
            {TT("diagDesc", "Journal de la session : appels au moteur, erreurs et événements. Copie ou exporte-le pour voir où ça a coincé.")}
          </p>
          <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)", flexWrap: "wrap", alignItems: "center" }}>
            <button className="chip-option" data-active={filter === "all"} onClick={() => setFilter("all")}>{TT("diagAll", "Tout")} · {allEntries.length}</button>
            <button className="chip-option" data-active={filter === "error"} onClick={() => setFilter("error")}>{TT("diagErrors", "Erreurs")} · {errCount}</button>
            <span className="spacer" />
            <button className="btn btn-sm" onClick={copyAll}><I name={copied ? "check" : "file"} size={13} /> {copied ? TT("diagCopied", "Copié") : TT("diagCopy", "Copier")}</button>
            <button className="btn btn-sm" onClick={exportFile}><I name="download" size={13} /> {TT("diagExport", "Exporter")}</button>
            <button className="btn btn-sm btn-ghost" onClick={() => window.HMLog.clear()}><I name="trash" size={13} /> {TT("diagClear", "Vider")}</button>
          </div>
          <div className="diag-log">
            {entries.length === 0 && <div className="soft" style={{ padding: "var(--space-6)", textAlign: "center", fontSize: "var(--fs-small)" }}>{TT("diagEmpty", "Aucun événement pour l'instant.")}</div>}
            {entries.map((e, i) => (
              <div key={i} className="diag-row" data-level={e.level}>
                <span className="diag-time mono">{new Date(e.t).toLocaleTimeString()}</span>
                <span className="diag-ev mono">{e.event}</span>
                {e.detail && <span className="diag-detail">{e.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { DiagnosticsModal });
