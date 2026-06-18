/* ============================================================
   settings.jsx — ENGINE chooser (local).
   Pick the brain that writes your lessons:
     • Ollama  — a model running on YOUR computer (offline, free)
     • Claude  — Anthropic's API (needs a key in the server's .env; stronger)
   The choice + model live in this browser (localStorage). The Claude key itself
   never touches the browser — it stays in the server's .env file.
   Component names (ApiKeyModal / AiSetupCard) are kept so main.jsx works unchanged.
   ============================================================ */
const { Icon: SetIcon } = window;

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 12) return k.slice(0, 4) + "••••";
  return k.slice(0, 8) + "••••••••" + k.slice(-4);
}

function Choice({ active, onClick, title, sub, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} className="option" data-active={active} style={{ flex: 1 }}>
      <div className="option-title">{title}</div>
      <div className="option-sub">{sub}</div>
    </button>
  );
}

/* ---- Engine settings modal ---- */
function ApiKeyModal({ open, onClose }) {
  const [provider, setProvider] = useState(window.getProvider());
  const [geminiModel, setGeminiModel] = useState(window.getGeminiModel?.() || "gemini-2.5-flash");
  const [ollamaModel, setOllamaModel] = useState(window.getOllamaModel());
  const [claudeModel, setClaudeModel] = useState(window.getClaudeModel());
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState(null);

  useEffect(() => {
    if (!open) return;
    setProvider(window.getProvider());
    setGeminiModel(window.getGeminiModel?.() || "gemini-2.5-flash");
    setOllamaModel(window.getOllamaModel());
    setClaudeModel(window.getClaudeModel());
    setLoading(true);
    window.serverHealth().then(h => { setHealth(h); setLoading(false); });
  }, [open]);

  if (!open) return null;

  const gemini = health && health.gemini;
  const ollama = health && health.ollama;
  const claude = health && health.claude;
  const models = (ollama && ollama.models) || [];
  const ollamaUp = ollama && ollama.up;
  const geminiReady = gemini && gemini.configured;
  const claudeReady = claude && claude.configured;

  function save() {
    window.setProvider(provider);
    window.setGeminiModel?.(geminiModel.trim());
    window.setOllamaModel(ollamaModel.trim());
    window.setClaudeModel(claudeModel.trim());
    onClose();
  }

  async function testEngine() {
    setTesting(true); setTestOut(null);
    let model = null;
    if (provider === "claude") model = claudeModel.trim() || null;
    else if (provider === "gemini") model = geminiModel.trim() || null;
    else model = ollamaModel.trim() || null;
    
    try {
      const r = await fetch("/api/llm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ system: "Réponds en un seul mot.", prompt: "Écris exactement : OK", provider, model }),
      });
      let j = {}; try { j = await r.json(); } catch (_) {}
      if (r.ok) setTestOut({ ok: true, msg: (j.text || "").trim().slice(0, 200) || "(réponse vide)" });
      else setTestOut({ ok: false, msg: j.detail || ("Erreur HTTP " + r.status) });
    } catch (e) {
      setTestOut({ ok: false, msg: "Le serveur local ne répond pas. Lance « python server.py » et ouvre http://localhost:8000 (pas le fichier .html directement)." });
    }
    setTesting(false);
  }

  return (
    <div onClick={onClose} className="modal-overlay">
      <div className="card fade-in modal-panel" onClick={e => e.stopPropagation()} style={{ width: "min(580px, 100%)" }}>
        <div className="accent-bar" />
        <div className="modal-body">
          <div className="modal-head">
            <div className="tile-icon"><SetIcon name="spark" size={20} /></div>
            <h2>{window.ui("engineTitle")}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><SetIcon name="x" size={18} /></button>
          </div>
          <p className="soft" style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, margin: "var(--space-1) 0 var(--space-5)" }}>
            {window.ui("engineDesc")}
          </p>

          <div style={{ display: "flex", gap: "var(--space-3)", marginBottom: "var(--space-5)", flexWrap: "wrap" }}>
            <Choice active={provider === "gemini"} onClick={() => setProvider("gemini")}
              title="Gemini 2.5 Flash" sub={geminiReady ? "✓ Gratuit · meilleur rapport" : "Ajoute GOOGLE_API_KEY au .env"} />
            <Choice active={provider === "claude"} onClick={() => setProvider("claude")}
              title="Claude — API" sub={claudeReady ? "✓ Clé détectée · qualité max" : "Ajoute ANTHROPIC_API_KEY au .env"} />
          </div>

          {loading && <div className="muted" style={{ fontSize: "var(--fs-small)" }}>{window.ui("engineVerifying")}</div>}

          {provider === "gemini" && (
            <div>
              <label className="field-label">Modèle Gemini</label>
              <input value={geminiModel} onChange={e => setGeminiModel(e.target.value)} placeholder="gemini-2.5-flash" className="field field--mono" />
              {!geminiReady && (
                <div className="hint hint--warn" style={{ marginTop: "var(--space-3)" }}>
                  Aucune clé détectée. Va sur <a href="https://ai.google.dev/" target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>ai.google.dev</a>, crée une clé gratuite, ajoute-la dans le fichier <span className="mono">.env</span> du serveur (<span className="mono">GOOGLE_API_KEY=…</span>), puis relance <span className="mono">python server.py</span>.
                </div>
              )}
              <div className="hint" style={{ marginTop: "var(--space-3)" }}>
                Plan gratuit : 1500 requêtes/jour, contexte 1M tokens, vision native. Idéal pour les leçons + diagrammes.
              </div>
            </div>
          )}

          {provider === "claude" && (
            <div>
              <label className="field-label">Modèle Claude (optionnel)</label>
              <input value={claudeModel} onChange={e => setClaudeModel(e.target.value)} placeholder={claude && claude.model ? claude.model : "claude-sonnet-4-20250514"} className="field field--mono" />
              {!claudeReady && (
                <div className="hint hint--warn" style={{ marginTop: "var(--space-3)" }}>
                  Aucune clé détectée. Ouvre le fichier <span className="mono">.env</span> du serveur, ajoute
                  <span className="mono"> ANTHROPIC_API_KEY=sk-ant-…</span>, puis relance <span className="mono">python server.py</span>.
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-5)", alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={save}><SetIcon name="check" size={16} /> {window.ui("btnSave")}</button>
            <button className="btn" onClick={testEngine} disabled={testing}>
              {testing ? <><Spinner size={14} /> Test…</> : <><SetIcon name="spark" size={15} /> {window.ui("engineTestBtn")}</>}
            </button>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: "var(--fs-caption)" }}>{window.ui("engineSaved")}</span>
          </div>

          {testOut && (
            <div className="mono" style={{
              marginTop: "var(--space-3)", fontSize: "var(--fs-micro)", lineHeight: 1.5, padding: "var(--space-3) var(--space-4)", borderRadius: "var(--radius-sm)", whiteSpace: "pre-wrap", wordBreak: "break-word",
              color: testOut.ok ? "var(--good)" : "var(--bad)",
              background: testOut.ok ? "var(--good-soft)" : "var(--bad-soft)",
              border: "1px solid " + (testOut.ok ? "color-mix(in oklch, var(--good) 35%, transparent)" : "color-mix(in oklch, var(--bad) 35%, transparent)"),
            }}>
              {testOut.ok ? "✓ Le moteur répond : " + testOut.msg : "✗ " + testOut.msg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Setup card (rarely shown now: the local server is always the engine) ---- */
function AiSetupCard({ onOpen }) {
  return (
    <div className="card fade-in" style={{ padding: 0, overflow: "hidden", maxWidth: 600, margin: "var(--space-2) auto" }}>
      <div className="accent-bar" style={{ height: 6 }} />
      <div style={{ padding: "var(--space-8) var(--space-7)", textAlign: "center" }}>
        <div className="tile-icon" style={{ width: 60, height: 60, borderRadius: 17, margin: "0 auto var(--space-4)" }}>
          <SetIcon name="spark" size={28} />
        </div>
        <h2 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--fs-h2)" }}>{window.ui("setupTitle")}</h2>
        <p className="soft" style={{ fontSize: "var(--fs-body-lg)", lineHeight: 1.65, maxWidth: 440, margin: "0 auto var(--space-6)" }}>
          {window.ui("setupDesc")}
        </p>
        <button className="btn btn-primary" onClick={onOpen} style={{ fontSize: "var(--fs-body-lg)", padding: "var(--space-3) var(--space-6)" }}>
          <SetIcon name="spark" size={17} /> {window.ui("setupBtn")}
        </button>
      </div>
    </div>
  );
}

/* ---- User preferences modal ---- */
const LANGS = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
];

function getNiveaux() {
  return [
    { id: "debutant",      label: window.ui("niveauDebutLabel"),  sub: window.ui("niveauDebutSub") },
    { id: "intermediaire", label: window.ui("niveauInterLabel"),  sub: window.ui("niveauInterSub") },
    { id: "avance",        label: window.ui("niveauAvanceLabel"), sub: window.ui("niveauAvanceSub") },
  ];
}

function NiveauBtn({ active, onClick, label, sub }) {
  return (
    <button onClick={onClick} className="option" data-active={active}>
      <div className="option-title">{label}</div>
      <div className="option-sub">{sub}</div>
    </button>
  );
}

function PrefsModal({ open, onClose }) {
  const [niveau,          setNiveauState]          = useState(window.getNiveau());
  const [langue,          setLangueState]          = useState(window.getLangue());
  const [planEnabled,     setPlanEnabledState]     = useState(window.getPlanEnabled());
  const [planDays,        setPlanDaysState]        = useState(window.getPlanDays());
  const [enabledSections, setEnabledSectionsState] = useState(window.getEnabledSections());

  useEffect(() => {
    if (!open) return;
    setNiveauState(window.getNiveau());
    setLangueState(window.getLangue());
    setPlanEnabledState(window.getPlanEnabled());
    setPlanDaysState(window.getPlanDays());
    setEnabledSectionsState(window.getEnabledSections());
  }, [open]);

  if (!open) return null;

  function save() {
    window.setNiveau(niveau);
    window.setLangue(langue);
    window.setPlanEnabled(planEnabled);
    window.setPlanDays(planDays);
    window.setEnabledSections(enabledSections);
    onClose();
  }

  function toggleSection(n) {
    setEnabledSectionsState(prev =>
      prev.includes(n)
        ? (prev.length > 1 ? prev.filter(x => x !== n) : prev) // keep at least 1
        : [...prev, n].sort((a, b) => a - b)
    );
  }

  return (
    <div onClick={onClose} className="modal-overlay">
      <div className="card fade-in modal-panel modal-panel--tall" onClick={e => e.stopPropagation()}>
        <div className="accent-bar" />
        <div className="modal-body">

          {/* Header */}
          <div className="modal-head" style={{ marginBottom: "var(--space-6)" }}>
            <div className="tile-icon" style={{ width: 36, height: 36, borderRadius: "var(--radius-sm)" }}><SetIcon name="target" size={18} /></div>
            <h2>{window.ui("prefsTitle")}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><SetIcon name="x" size={18} /></button>
          </div>

          {/* Niveau */}
          <div className="form-section">
            <label className="field-label">{window.ui("prefsNiveauLabel")}</label>
            <p className="soft" style={{ fontSize: "var(--fs-small)", margin: "0 0 var(--space-3)", lineHeight: 1.5 }}>
              {window.ui("prefsNiveauNote")}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {getNiveaux().map(n => (
                <NiveauBtn key={n.id} active={niveau === n.id} onClick={() => setNiveauState(n.id)} label={n.label} sub={n.sub} />
              ))}
            </div>
          </div>

          {/* Langue */}
          <div className="form-section">
            <label className="field-label">{window.ui("prefsLangueLabel")}</label>
            <p className="soft" style={{ fontSize: "var(--fs-small)", margin: "0 0 var(--space-3)", lineHeight: 1.5 }}>
              {window.ui("prefsLangueNote")}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {LANGS.map(l => (
                <button key={l.code} onClick={() => setLangueState(l.code)} className="chip-option" data-active={langue === l.code}>{l.label}</button>
              ))}
            </div>
          </div>

          {/* Sections */}
          <div className="form-section">
            <label className="field-label">{window.ui("prefsSectionsLabel")}</label>
            <p className="soft" style={{ fontSize: "var(--fs-small)", margin: "0 0 var(--space-3)", lineHeight: 1.5 }}>
              {window.ui("prefsSectionsNote")}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-1) var(--space-3)" }}>
              {window.SECTIONS.map(s => {
                const on = enabledSections.includes(s.n);
                return (
                  <label key={s.n} className="option" data-active={on} style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)" }}>
                    <input type="checkbox" checked={on} onChange={() => toggleSection(s.n)} style={{ marginTop: 2, accentColor: "var(--accent)", flexShrink: 0 }} />
                    <span>
                      <span className="mono" style={{ fontSize: "var(--fs-caption)", fontWeight: 700, color: "var(--ink-faint)", marginRight: 5 }}>{s.n}.</span>
                      <span style={{ fontSize: "var(--fs-small)", lineHeight: 1.4 }}>{s.court}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Plan */}
          <div style={{ marginBottom: "var(--space-6)" }}>
            <label className="field-label">{window.ui("prefsPlanLabel")}</label>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap" }}>
              <button onClick={() => setPlanEnabledState(v => !v)} className="chip-option" data-tone="good" data-active={planEnabled} style={{ fontWeight: 600 }}>
                {planEnabled ? window.ui("prefsPlanActivated") : window.ui("prefsPlanDisabled")}
              </button>
              {planEnabled && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span className="soft" style={{ fontSize: "var(--fs-small)" }}>{window.ui("prefsPlanDuration")}</span>
                  <input
                    type="number" min={7} max={365} value={planDays}
                    onChange={e => setPlanDaysState(Math.max(7, Math.min(365, parseInt(e.target.value) || 40)))}
                    className="field field--mono" style={{ width: 72, textAlign: "center" }}
                  />
                  <span className="soft" style={{ fontSize: "var(--fs-small)" }}>{window.ui("prefsPlanDays")}</span>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", paddingTop: "var(--space-1)" }}>
            <button className="btn btn-primary" onClick={save}><SetIcon name="check" size={15} /> {window.ui("btnSave")}</button>
            <button className="btn" onClick={onClose}>{window.ui("btnCancel")}</button>
            <span className="muted" style={{ fontSize: "var(--fs-caption)", flex: 1, textAlign: "right" }}>{window.ui("prefsNote")}</span>
          </div>

        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ApiKeyModal, AiSetupCard, PrefsModal, maskKey });
