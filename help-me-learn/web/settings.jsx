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
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, textAlign: "left", padding: "14px 16px", borderRadius: 12, cursor: disabled ? "not-allowed" : "pointer",
        border: "1.5px solid " + (active ? "var(--accent)" : "var(--line)"),
        background: active ? "var(--accent-soft)" : "var(--surface-2)",
        color: active ? "var(--accent-deep)" : "var(--ink)", opacity: disabled ? 0.55 : 1, transition: "all 0.15s ease",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 15.5, fontFamily: "var(--font-serif)" }}>{title}</div>
      <div style={{ fontSize: 12.5, marginTop: 3, color: active ? "var(--accent-deep)" : "var(--ink-soft)", lineHeight: 1.45 }}>{sub}</div>
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

  const inputStyle = { width: "100%", fontFamily: "var(--font-mono)", fontSize: 13.5, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--paper)", color: "var(--ink)", outline: "none" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "oklch(0.12 0.02 264 / 0.62)", backdropFilter: "blur(4px)", display: "grid", placeItems: "center", padding: 18 }}>
      <div className="card fade-in" onClick={e => e.stopPropagation()} style={{ width: "min(580px, 100%)", padding: 0, overflow: "hidden", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ height: 5, background: "var(--grad-accent)" }} />
        <div style={{ padding: "24px 26px 26px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, flex: "none", display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent-deep)" }}>
              <SetIcon name="spark" size={20} />
            </div>
            <h2 style={{ margin: 0, fontSize: 22 }}>{window.ui("engineTitle")}</h2>
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><SetIcon name="x" size={18} /></button>
          </div>
          <p className="soft" style={{ fontSize: 14.5, lineHeight: 1.6, margin: "4px 0 18px" }}>
            {window.ui("engineDesc")}
          </p>

          <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
            <Choice active={provider === "gemini"} onClick={() => setProvider("gemini")}
              title="Gemini 2.5 Flash" sub={geminiReady ? "✓ Gratuit · meilleur rapport" : "Ajoute GOOGLE_API_KEY au .env"} />
            <Choice active={provider === "claude"} onClick={() => setProvider("claude")}
              title="Claude — API" sub={claudeReady ? "✓ Clé détectée · qualité max" : "Ajoute ANTHROPIC_API_KEY au .env"} />
          </div>

          {loading && <div className="muted" style={{ fontSize: 13 }}>{window.ui("engineVerifying")}</div>}

          {provider === "gemini" && (
            <div>
              <label className="mono" style={{ fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-faint)" }}>Modèle Gemini</label>
              <input value={geminiModel} onChange={e => setGeminiModel(e.target.value)} placeholder="gemini-2.5-flash" style={{ ...inputStyle, marginTop: 7 }} />
              {!geminiReady && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--ochre-deep)", lineHeight: 1.55 }}>
                  Aucune clé détectée. Va sur <a href="https://ai.google.dev/" target="_blank" rel="noopener noreferrer" style={{color: "var(--ochre-deep)", textDecoration: "underline"}}>ai.google.dev</a>, crée une clé gratuite, ajoute-la dans le fichier <span className="mono">.env</span> du serveur (<span className="mono">GOOGLE_API_KEY=…</span>), puis relance <span className="mono">python server.py</span>.
                </div>
              )}
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.55 }}>
                Plan gratuit : 1500 requêtes/jour, contexte 1M tokens, vision native. Idéal pour les leçons + diagrammes.
              </div>
            </div>
          )}

          {provider === "claude" && (
            <div>
              <label className="mono" style={{ fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-faint)" }}>Modèle Claude (optionnel)</label>
              <input value={claudeModel} onChange={e => setClaudeModel(e.target.value)} placeholder={claude && claude.model ? claude.model : "claude-sonnet-4-20250514"} style={{ ...inputStyle, marginTop: 7 }} />
              {!claudeReady && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--ochre-deep)", lineHeight: 1.55 }}>
                  Aucune clé détectée. Ouvre le fichier <span className="mono">.env</span> du serveur, ajoute
                  <span className="mono"> ANTHROPIC_API_KEY=sk-ant-…</span>, puis relance <span className="mono">python server.py</span>.
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 20, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={save}><SetIcon name="check" size={16} /> {window.ui("btnSave")}</button>
            <button className="btn" onClick={testEngine} disabled={testing}>
              {testing ? <><Spinner size={14} /> Test…</> : <><SetIcon name="spark" size={15} /> {window.ui("engineTestBtn")}</>}
            </button>
            <span style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 12 }}>{window.ui("engineSaved")}</span>
          </div>

          {testOut && (
            <div className="mono" style={{
              marginTop: 12, fontSize: 12.5, lineHeight: 1.5, padding: "10px 13px", borderRadius: 10, whiteSpace: "pre-wrap", wordBreak: "break-word",
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
    <div className="card fade-in" style={{ padding: 0, overflow: "hidden", maxWidth: 600, margin: "6px auto" }}>
      <div style={{ height: 6, background: "var(--grad-accent)" }} />
      <div style={{ padding: "34px 30px", textAlign: "center" }}>
        <div style={{ width: 60, height: 60, borderRadius: 17, margin: "0 auto 18px", display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent-deep)" }}>
          <SetIcon name="spark" size={28} />
        </div>
        <h2 style={{ margin: "0 0 10px", fontSize: 25 }}>{window.ui("setupTitle")}</h2>
        <p className="soft" style={{ fontSize: 15.5, lineHeight: 1.65, maxWidth: 440, margin: "0 auto 22px" }}>
          {window.ui("setupDesc")}
        </p>
        <button className="btn btn-primary" onClick={onOpen} style={{ fontSize: 15.5, padding: "12px 22px" }}>
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
    <button onClick={onClick} style={{
      width: "100%", textAlign: "left", padding: "11px 14px", borderRadius: 10, cursor: "pointer",
      border: "1.5px solid " + (active ? "var(--accent)" : "var(--line)"),
      background: active ? "var(--accent-soft)" : "var(--surface-2)",
      color: active ? "var(--accent-deep)" : "var(--ink)",
      transition: "all 0.12s ease",
    }}>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{label}</div>
      <div style={{ fontSize: 12, marginTop: 2, color: active ? "var(--accent-deep)" : "var(--ink-soft)", lineHeight: 1.4 }}>{sub}</div>
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

  const labelStyle = { fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 10, display: "block" };
  const sectionStyle = { marginBottom: 22, paddingBottom: 22, borderBottom: "1px solid var(--line)" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "oklch(0.12 0.02 264 / 0.62)", backdropFilter: "blur(4px)", display: "grid", placeItems: "center", padding: 18 }}>
      <div className="card fade-in" onClick={e => e.stopPropagation()} style={{ width: "min(600px, 100%)", maxHeight: "88vh", overflowY: "auto", padding: 0, boxShadow: "var(--shadow-lg)" }}>
        <div style={{ height: 5, background: "var(--grad-accent)" }} />
        <div style={{ padding: "22px 24px 24px" }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent-deep)", flex: "none" }}>
              <SetIcon name="target" size={18} />
            </div>
            <h2 style={{ margin: 0, fontSize: 21 }}>{window.ui("prefsTitle")}</h2>
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><SetIcon name="x" size={18} /></button>
          </div>

          {/* Niveau */}
          <div style={sectionStyle}>
            <label style={labelStyle}>{window.ui("prefsNiveauLabel")}</label>
            <p className="soft" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
              {window.ui("prefsNiveauNote")}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {getNiveaux().map(n => (
                <NiveauBtn key={n.id} active={niveau === n.id} onClick={() => setNiveauState(n.id)} label={n.label} sub={n.sub} />
              ))}
            </div>
          </div>

          {/* Langue */}
          <div style={sectionStyle}>
            <label style={labelStyle}>{window.ui("prefsLangueLabel")}</label>
            <p className="soft" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
              {window.ui("prefsLangueNote")}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {LANGS.map(l => (
                <button key={l.code} onClick={() => setLangueState(l.code)} style={{
                  padding: "7px 14px", borderRadius: 9, cursor: "pointer", fontSize: 14, fontWeight: langue === l.code ? 700 : 400,
                  border: "1.5px solid " + (langue === l.code ? "var(--accent)" : "var(--line)"),
                  background: langue === l.code ? "var(--accent-soft)" : "var(--surface-2)",
                  color: langue === l.code ? "var(--accent-deep)" : "var(--ink)",
                  transition: "all 0.12s ease",
                }}>{l.label}</button>
              ))}
            </div>
          </div>

          {/* Sections */}
          <div style={sectionStyle}>
            <label style={labelStyle}>{window.ui("prefsSectionsLabel")}</label>
            <p className="soft" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
              {window.ui("prefsSectionsNote")}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px" }}>
              {window.SECTIONS.map(s => {
                const on = enabledSections.includes(s.n);
                return (
                  <label key={s.n} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", padding: "7px 10px", borderRadius: 9, border: "1px solid " + (on ? "var(--accent-line)" : "var(--line)"), background: on ? "var(--accent-soft)" : "var(--surface-2)", transition: "all 0.12s" }}>
                    <input type="checkbox" checked={on} onChange={() => toggleSection(s.n)} style={{ marginTop: 2, accentColor: "var(--accent)", flexShrink: 0 }} />
                    <span>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-faint)", marginRight: 5 }}>{s.n}.</span>
                      <span style={{ fontSize: 13, lineHeight: 1.4 }}>{s.court}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Plan */}
          <div style={{ marginBottom: 22 }}>
            <label style={labelStyle}>{window.ui("prefsPlanLabel")}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <button onClick={() => setPlanEnabledState(v => !v)} style={{
                padding: "8px 16px", borderRadius: 9, cursor: "pointer", fontSize: 14, fontWeight: 600,
                border: "1.5px solid " + (planEnabled ? "var(--good)" : "var(--line)"),
                background: planEnabled ? "var(--good-soft)" : "var(--surface-2)",
                color: planEnabled ? "var(--good)" : "var(--ink-soft)",
                transition: "all 0.12s ease",
              }}>{planEnabled ? window.ui("prefsPlanActivated") : window.ui("prefsPlanDisabled")}</button>
              {planEnabled && (
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span className="soft" style={{ fontSize: 13.5 }}>{window.ui("prefsPlanDuration")}</span>
                  <input
                    type="number" min={7} max={365} value={planDays}
                    onChange={e => setPlanDaysState(Math.max(7, Math.min(365, parseInt(e.target.value) || 40)))}
                    style={{ width: 72, fontFamily: "var(--font-mono)", fontSize: 14, padding: "7px 10px", borderRadius: 9, border: "1px solid var(--line)", background: "var(--paper)", color: "var(--ink)", textAlign: "center" }}
                  />
                  <span className="soft" style={{ fontSize: 13.5 }}>{window.ui("prefsPlanDays")}</span>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", paddingTop: 6 }}>
            <button className="btn btn-primary" onClick={save}><SetIcon name="check" size={15} /> {window.ui("btnSave")}</button>
            <button className="btn" onClick={onClose}>{window.ui("btnCancel")}</button>
            <span className="muted" style={{ fontSize: 12, flex: 1, textAlign: "right" }}>{window.ui("prefsNote")}</span>
          </div>

        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ApiKeyModal, AiSetupCard, PrefsModal, maskKey });
