/* ============================================================
   main.jsx — root: sidebar shell, theme, persistence, generation
   ============================================================ */
const { Icon: AIcon, useState: uS, useEffect: uE, useRef: uR } = window;

/* Tabs are built inside App using ui() so they update on language change */

/* Live section-by-section progress tracker shown in sidebar during generation */
function GenTimeline({ chapter }) {
  if (!chapter) return null;
  const sections = chapter.sections || [];
  const done = sections.filter(s => s.status === "done").length;
  const quizSt  = chapter.quizStatus  === "done" ? "done"  : chapter.quizStatus  === "loading" ? "loading" : "pending";
  const cardsSt = chapter.cardsStatus === "done" ? "done"  : chapter.cardsStatus === "loading" ? "loading" : "pending";
  return (
    <div className="gen-timeline">
      <div className="gen-timeline-header">
        <Spinner size={12} />
        <span className="gen-timeline-label">{window.ui("generating")}</span>
        <span className="gen-timeline-count">{done}/{sections.length}</span>
      </div>
      {sections.map(s => (
        <div key={s.n} className="gen-timeline-row" data-done={s.status === "done"}>
          <span className={`gen-dot gen-dot--${s.status}`} />
          <span className="gen-timeline-name" style={{
            color: s.status === "done" ? "var(--ink-soft)" : s.status === "loading" ? "var(--accent-deep)" : "var(--ink-faint)",
          }}>{s.court || String(s.n)}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4, paddingTop: 6, borderTop: "1px solid var(--line)" }}>
        <div className="gen-timeline-row" style={{ gap: 6 }}>
          <span className={`gen-dot gen-dot--${quizSt}`} />
          <span className="gen-timeline-name" style={{ color: "var(--ink-faint)" }}>Quiz</span>
        </div>
        <div className="gen-timeline-row" style={{ gap: 6 }}>
          <span className={`gen-dot gen-dot--${cardsSt}`} />
          <span className="gen-timeline-name" style={{ color: "var(--ink-faint)" }}>Cards</span>
        </div>
      </div>
    </div>
  );
}

/* Run async task functions with at most `limit` concurrent promises */
async function runConcurrent(tasks, limit, shouldStop) {
  const queue = [...tasks];
  async function worker() {
    while (queue.length) { if (shouldStop && shouldStop()) break; const t = queue.shift(); if (t) await t(); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const LS_KEY = "hml_state_v2";
let CH_SEQ = 1;
let INS_SEQ = 1;
let HIDE_SEQ = 1;

function newId() { return "ch" + (CH_SEQ++); }
function newInsertionId() { return "ins" + (INS_SEQ++); }
function newHiddenId() { return "hid" + (HIDE_SEQ++); }
function freshChapter(source, fromFile, figures) {
  const enabledNums = window.getEnabledSections();
  return {
    id: newId(), source, fromFile: fromFile || "",
    titre: "", theme: "", langueSource: "", lisible: null, manque: "",
    termes: [], figures: Array.isArray(figures) ? figures : [],
    sections: window.SECTIONS.filter(s => enabledNums.includes(s.n)).map(s => {
      const lbl = window.getSectionLabels(s.n, window.getLangue());
      return { n: s.n, titre: lbl.titre, court: lbl.court, status: "pending", contenu: "" };
    }),
    quiz: null, quizStatus: "idle",
    cards: null, cardsStatus: "idle",
    aVerifier: [], prochaineEtape: "",
    insertions: [],
    hiddenBlocks: [],
    status: "generating", mastered: false, createdAt: Date.now(),
  };
}

/* ---- persistence helpers ---- */
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.chapters)) return null;
    // sanitize: interrupted generations shouldn't look "running"
    d.chapters.forEach(c => {
      (c.sections || []).forEach(s => { if (s.status === "loading") s.status = s.contenu ? "done" : "pending"; });
      if (c.status === "generating") c.status = "done";
      if (c.quizStatus === "loading") c.quizStatus = c.quiz ? "done" : "idle";
      if (c.cardsStatus === "loading") c.cardsStatus = c.cards ? "done" : "idle";
    });
    // restore id sequence
    let max = 0;
    d.chapters.forEach(c => { const m = /ch(\d+)/.exec(c.id || ""); if (m) max = Math.max(max, +m[1]); });
    CH_SEQ = max + 1;
    // restore insertion-id sequence (old chapters may have no `insertions` array yet)
    let imax = 0;
    d.chapters.forEach(c => (c.insertions || []).forEach(ins => { const m = /ins(\d+)/.exec(ins.id || ""); if (m) imax = Math.max(imax, +m[1]); }));
    INS_SEQ = imax + 1;
    // restore hidden-passage-id sequence (old chapters may have no `hiddenBlocks` array yet)
    let hmax = 0;
    d.chapters.forEach(c => (c.hiddenBlocks || []).forEach(h => { const m = /hid(\d+)/.exec(h.id || ""); if (m) hmax = Math.max(hmax, +m[1]); }));
    HIDE_SEQ = hmax + 1;
    // restore figure-id sequence + re-register original course images
    let fmax = 0;
    window.HML_FIGS = window.HML_FIGS || {};
    d.chapters.forEach(c => (c.figures || []).forEach(f => {
      const fm = /f(\d+)/.exec(f.id || ""); if (fm) fmax = Math.max(fmax, +fm[1]);
      if (f.url && window.registerFigImage) window.registerFigImage(c.id, f.id, f.url);
    }));
    window.FIG_SEQ = Math.max(window.FIG_SEQ || 1, fmax + 1);
    return d;
  } catch (e) { return null; }
}
const SAVED = loadState();

/* Persist a chapter's ORIGINAL images out-of-band (own server table), so they
   survive reloads and sync across devices — the state blob deliberately drops
   the heavy base64. Chunked to keep each request modest. Best-effort. */
async function uploadFigures(courseId, figs) {
  if (!courseId) return;
  const all = (figs || []).filter(f => f && f.id && f.url).map(f => ({ id: f.id, url: f.url }));
  for (let i = 0; i < all.length; i += 8) {
    try {
      await fetch("/api/figures", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseId, figures: all.slice(i, i + 8) }),
      });
    } catch (_) { /* offline / not critical — registry still serves this session */ }
  }
}
window.uploadFigures = uploadFigures;

/* Login / create-account modal. On success we reload so the app re-fetches the
   now per-user state from the server (courses follow you across devices). */
function AuthModal({ open, onClose, onAuthed }) {
  const [mode, setMode] = uS("login");   // "login" | "register" | "forgot"
  const [email, setEmail] = uS("");
  const [password, setPassword] = uS("");
  const [busy, setBusy] = uS(false);
  const [err, setErr] = uS("");
  const [showPw, setShowPw] = uS(false);
  const [sent, setSent] = uS(false);
  if (!open) return null;

  async function submit(e) {
    if (e) e.preventDefault();
    setErr(""); setBusy(true);
    try {
      if (mode === "forgot") {
        await fetch("/api/auth/forgot", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        setSent(true); setBusy(false); return;   // always succeeds — never leaks if the email exists
      }
      const r = await fetch("/api/auth/" + mode, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || "Échec de la connexion.");
      if (onAuthed) onAuthed(data);
      window.location.reload();   // refetch per-user state
    } catch (e2) {
      setErr((e2 && e2.message) || String(e2));
      setBusy(false);
    }
  }

  const isReg = mode === "register";
  const isForgot = mode === "forgot";
  return (
    <div onClick={onClose} className="modal-overlay">
      <div className="card fade-in modal-panel" onClick={e => e.stopPropagation()} style={{ width: "min(440px, 100%)" }}>
        <div className="accent-bar" />
        <div className="modal-body">
          <div className="modal-head">
            <div className="tile-icon"><AIcon name="target" size={20} /></div>
            <h2>{isForgot ? "Mot de passe oublié" : isReg ? "Créer un compte" : "Se connecter"}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><AIcon name="x" size={18} /></button>
          </div>
          {isForgot && sent ? (
            <>
              <p className="soft" style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, margin: "var(--space-1) 0 var(--space-4)" }}>
                Si un compte existe pour <b>{email.trim()}</b>, un lien de réinitialisation vient d'être envoyé (valable 1 heure). Pense à vérifier tes spams.
              </p>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSent(false); setErr(""); setMode("login"); }}
                style={{ width: "100%", justifyContent: "center" }}>Retour à la connexion</button>
            </>
          ) : (
            <>
              <p className="soft" style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, margin: "var(--space-1) 0 var(--space-4)" }}>
                {isForgot
                  ? "Entre ton email : on t'enverra un lien pour choisir un nouveau mot de passe."
                  : "Connecte-toi pour retrouver tes cours sur tous tes appareils."}
              </p>
              <form onSubmit={submit}>
                <label className="field-label">Email</label>
                <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="toi@exemple.com" className="field" required />
                {!isForgot && (
                  <>
                    <label className="field-label" style={{ marginTop: "var(--space-3)" }}>Mot de passe</label>
                    <div style={{ position: "relative" }}>
                      <input type={showPw ? "text" : "password"} autoComplete={isReg ? "new-password" : "current-password"} value={password}
                        onChange={e => setPassword(e.target.value)} placeholder={isReg ? "6 caractères minimum" : "••••••••"} className="field" style={{ width: "100%", paddingRight: 42 }} required />
                      <button type="button" className="icon-btn" onClick={() => setShowPw(s => !s)}
                        aria-label={showPw ? "Masquer le mot de passe" : "Afficher le mot de passe"} title={showPw ? "Masquer" : "Afficher"}
                        style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>
                        <AIcon name={showPw ? "eyeoff" : "eye"} size={16} />
                      </button>
                    </div>
                  </>
                )}
                {err && <div className="hint hint--warn" style={{ marginTop: "var(--space-3)" }}>{err}</div>}
                <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-4)" }}>
                  {busy ? <Spinner size={15} /> : <AIcon name={isForgot ? "message" : isReg ? "plusbig" : "target"} size={15} />}
                  {isForgot ? "Envoyer le lien" : isReg ? "Créer mon compte" : "Se connecter"}
                </button>
              </form>
              {!isForgot && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setErr(""); setMode(isReg ? "login" : "register"); }}
                  style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-3)" }}>
                  {isReg ? "J'ai déjà un compte — me connecter" : "Pas de compte ? En créer un"}
                </button>
              )}
              {mode === "login" && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setErr(""); setMode("forgot"); }}
                  style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-1)" }}>
                  Mot de passe oublié ?
                </button>
              )}
              {isForgot && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setErr(""); setMode("login"); }}
                  style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-3)" }}>
                  Retour à la connexion
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Password-reset screen, shown when the URL carries ?reset=<token>
   (the link emailed by /api/auth/forgot). On success the user is logged in. */
function ResetModal({ token, onClose }) {
  const [password, setPassword] = uS("");
  const [busy, setBusy] = uS(false);
  const [err, setErr] = uS("");
  const [showPw, setShowPw] = uS(false);
  async function submit(e) {
    if (e) e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const r = await fetch("/api/auth/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || "Échec.");
      try { const u = new URL(window.location.href); u.searchParams.delete("reset"); window.history.replaceState({}, "", u); } catch (_) {}
      window.location.reload();   // now logged in with the new password
    } catch (e2) { setErr((e2 && e2.message) || String(e2)); setBusy(false); }
  }
  return (
    <div className="modal-overlay">
      <div className="card fade-in modal-panel" onClick={e => e.stopPropagation()} style={{ width: "min(440px, 100%)" }}>
        <div className="accent-bar" />
        <div className="modal-body">
          <div className="modal-head">
            <div className="tile-icon"><AIcon name="target" size={20} /></div>
            <h2>Nouveau mot de passe</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><AIcon name="x" size={18} /></button>
          </div>
          <p className="soft" style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, margin: "var(--space-1) 0 var(--space-4)" }}>
            Choisis un nouveau mot de passe pour ton compte.
          </p>
          <form onSubmit={submit}>
            <label className="field-label">Nouveau mot de passe</label>
            <div style={{ position: "relative" }}>
              <input type={showPw ? "text" : "password"} autoComplete="new-password" value={password}
                onChange={e => setPassword(e.target.value)} placeholder="6 caractères minimum" className="field" style={{ width: "100%", paddingRight: 42 }} required />
              <button type="button" className="icon-btn" onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? "Masquer" : "Afficher"} title={showPw ? "Masquer" : "Afficher"}
                style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>
                <AIcon name={showPw ? "eyeoff" : "eye"} size={16} />
              </button>
            </div>
            {err && <div className="hint hint--warn" style={{ marginTop: "var(--space-3)" }}>{err}</div>}
            <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-4)" }}>
              {busy ? <Spinner size={15} /> : <AIcon name="check" size={15} />}
              Choisir ce mot de passe
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [theme, setTheme] = uS((SAVED && SAVED.theme) || "dark");
  const [tab, setTab] = uS(SAVED && SAVED.chapters && SAVED.chapters.length ? "library" : "learn");
  const [chapters, setChapters] = uS(SAVED ? SAVED.chapters : []);
  const [currentId, setCurrentId] = uS(SAVED ? SAVED.currentId : null);
  const [progressLog, setProgressLog] = uS((SAVED && Array.isArray(SAVED.progressLog)) ? SAVED.progressLog : []);
  function logProgress(ev) {
    setProgressLog(prev => {
      const next = prev.concat([{ t: Date.now(), ...ev }]);
      return next.length > 2000 ? next.slice(next.length - 2000) : next;   // keep it bounded
    });
  }
  const [home, setHome] = uS(!(SAVED && SAVED.chapters && SAVED.chapters.length));
  const [generating, setGenerating] = uS(false);
  const [toast, setToast] = uS("");
  const [provider, setProviderState] = uS(window.getProvider());
  const [showSettings, setShowSettings] = uS(false);
  const [showPrefs, setShowPrefs] = uS(false);
  const [navClosed, setNavClosed] = uS(() => { try { return localStorage.getItem("hml.navClosed") === "1"; } catch (_) { return false; } });
  function toggleNav() {
    setNavClosed(v => { const nv = !v; try { localStorage.setItem("hml.navClosed", nv ? "1" : "0"); } catch (_) {} return nv; });
  }
  const [showDiag, setShowDiag] = uS(false);
  const [diagErrors, setDiagErrors] = uS(0);
  const [user, setUser] = uS(null);          // { email } when logged in, else null
  const [showAuth, setShowAuth] = uS(false);
  const [resetToken, setResetToken] = uS(() => { try { return new URL(window.location.href).searchParams.get("reset") || ""; } catch (_) { return ""; } });
  const [acctOpen, setAcctOpen] = uS(false); // account dropdown (email + logout)
  window.useOutsideClose(acctOpen, () => setAcctOpen(false), ".acct-wrap");
  function onAccountClick() { if (user) setAcctOpen(o => !o); else setShowAuth(true); }
  uE(() => { fetch("/api/auth/me").then(r => r.json()).then(setUser).catch(() => {}); }, []);
  async function logout() { try { await fetch("/api/auth/logout", { method: "POST" }); } catch (_) {} window.location.reload(); }
  uE(() => {
    if (!window.HMLog) return;
    const upd = () => setDiagErrors(window.HMLog.errorCount());
    upd();
    return window.HMLog.subscribe(upd);
  }, []);

  // proactive backend-online detection (Nielsen #1/#5): warn BEFORE the user hits a failed action
  const [serverOnline, setServerOnline] = uS(true);
  uE(() => {
    let alive = true;
    async function check() {
      try { const r = await fetch("/api/health", { method: "GET" }); if (alive) setServerOnline(!!(r && r.ok)); }
      catch (_) { if (alive) setServerOnline(false); }
    }
    check();
    const t = setInterval(check, 20000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // cancel an in-flight generation (Nielsen #3)
  const cancelRef = uR(false);
  function stopGeneration() { cancelRef.current = true; flash(window.ui("genStopped")); }

  // undo course deletion (Nielsen #3)
  const [undo, setUndo] = uS(null);
  const undoTimer = uR(null);
  function undoDelete() {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(u => { if (u && u.ch) setChapters(prev => prev.some(c => c.id === u.ch.id) ? prev : [...prev, u.ch]); return null; });
  }
  const [planEnabled, setPlanEnabledState] = uS(window.getPlanEnabled());
  const [planDays, setPlanDaysState] = uS(window.getPlanDays());
  const [uiLang, setUiLang] = uS(window.getLangue());
  const chaptersRef = uR(chapters);
  chaptersRef.current = chapters;

  const aiReady = true;               // the local server is always the engine
  const TABS = [
    { id: "learn",   label: window.ui("tabLearn"),   icon: "learn" },
    { id: "library", label: window.ui("tabLibrary"), icon: "library" },
    { id: "quiz",    label: window.ui("tabQuiz"),    icon: "quiz" },
    { id: "cards",   label: window.ui("tabCards"),   icon: "cards" },
    { id: "progress", label: window.ui("tabProgress") || "Progression", icon: "progress" },
    ...(planEnabled ? [{ id: "plan", label: window.ui("tabPlan") + " " + planDays + window.ui("tabPlanUnit"), icon: "plan" }] : []),
  ];
  function closeSettings() { setProviderState(window.getProvider()); setShowSettings(false); }
  function closePrefs() {
    const savedLang = window.getLangue();
    const newPlanEnabled = window.getPlanEnabled();
    setPlanEnabledState(newPlanEnabled);
    setPlanDaysState(window.getPlanDays());
    if (!newPlanEnabled && tab === "plan") setTab("library");
    setShowPrefs(false);
    if (savedLang !== uiLang) { setTimeout(() => window.location.reload(), 80); }
  }

  uE(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);

  /* persist (with graceful fallback if image blobs blow the quota) */
  uE(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ chapters, currentId, theme, progressLog }));
    } catch (e) {
      try {
        const light = { chapters: chapters.map(c => ({ ...c, figures: (c.figures || []).map(f => ({ id: f.id, page: f.page, w: f.w, h: f.h })) })), currentId, theme, progressLog };
        localStorage.setItem(LS_KEY, JSON.stringify(light));
      } catch (_) { /* still over quota — keep text in memory only */ }
    }
  }, [chapters, currentId, theme, progressLog]);

  /* keep the original-image registry in sync so ```img``` blocks resolve */
  uE(() => {
    if (!window.registerFigImage) return;
    chapters.forEach(c => (c.figures || []).forEach(f => { if (f.url) window.registerFigImage(c.id, f.id, f.url); }));
  }, [chapters]);

  /* ---- SQLite persistence: sync on mount, save on change ---- */
  uE(() => {
    // On mount: load server state and migrate localStorage if needed
    (async () => {
      try {
        const r = await fetch("/api/state");
        if (!r.ok) return;
        const serverState = await r.json();

        if (!serverState || !Array.isArray(serverState.chapters)) {
          // Server empty — migrate existing localStorage data
          const local = SAVED;
          if (local && local.chapters && local.chapters.length > 0) {
            fetch("/api/state", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ data: JSON.stringify(local) }),
            }).catch(() => {});
          }
          return;
        }

        // Server has data — only use it if it has MORE chapters than current local state.
        // This prevents test/stale server data from overwriting a richer local state.
        const serverChs = serverState.chapters || [];
        const localChs  = chapters; // React state at mount time
        if (serverChs.length > localChs.length) {
          // Server has chapters this browser hasn't seen — restore from server
          serverChs.forEach(c => {
            (c.sections || []).forEach(s => { if (s.status === "loading") s.status = s.contenu ? "done" : "pending"; });
            if (c.status === "generating") c.status = "done";
          });
          let max = 0;
          serverChs.forEach(c => { const m = /ch(\d+)/.exec(c.id || ""); if (m) max = Math.max(max, +m[1]); });
          CH_SEQ = max + 1;
          let imax = 0;
          serverChs.forEach(c => (c.insertions || []).forEach(ins => { const m = /ins(\d+)/.exec(ins.id || ""); if (m) imax = Math.max(imax, +m[1]); }));
          INS_SEQ = Math.max(INS_SEQ, imax + 1);
          setChapters(serverChs);
          if (serverState.currentId) setCurrentId(serverState.currentId);
          if (serverState.theme)     setTheme(serverState.theme);
          if (Array.isArray(serverState.progressLog)) setProgressLog(serverState.progressLog);
          if (!serverChs.length) { setHome(true); setTab("learn"); }
        } else if (localChs.length > serverChs.length) {
          // Local has more chapters — push local state to server to update it
          fetch("/api/state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data: JSON.stringify({ chapters: localChs, currentId, theme, progressLog }) }),
          }).catch(() => {});
        }
      } catch (e) {}
    })();
  }, []); // only on mount

  const _saveTimer = uR(null);
  uE(() => {
    if (_saveTimer.current) clearTimeout(_saveTimer.current);
    _saveTimer.current = setTimeout(() => {
      fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: JSON.stringify({ chapters, currentId, theme, progressLog }) }),
      }).catch(() => {});
    }, 2500); // debounce 2.5s after last change
    return () => { if (_saveTimer.current) clearTimeout(_saveTimer.current); };
  }, [chapters, currentId, theme, progressLog]);

  const current = chapters.find(c => c.id === currentId) || null;
  // display the course in its chosen language (translated overlay) across all tabs
  const currentView = (current && window.courseView) ? window.courseView(current) : current;
  function setChapterLang(chapterId, lang) { patchChapter(chapterId, { displayLang: lang }); }

  function patchChapter(id, patch) {
    setChapters(prev => prev.map(c => c.id === id ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c));
  }
  function patchSection(id, n, patch) {
    setChapters(prev => prev.map(c => c.id !== id ? c : { ...c, sections: c.sections.map(s => s.n === n ? { ...s, ...patch } : s) }));
  }
  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 2600); }

  /* ---- translate a whole course into another display language (offline, cached) ----
     Done section-by-section (small requests) so no single call is long enough to
     trip a proxy/tunnel timeout; reports progress and caches the result. */
  async function translateChapter(chapterId, target, onProgress) {
    const ch = chapters.find(c => c.id === chapterId);
    if (!ch) return { ok: false, error: "Cours introuvable." };
    const source = ch.lang || window.getLangue() || "fr";
    if (source === target) return { ok: true };
    if (ch.i18n && ch.i18n[target]) return { ok: true };          // already cached
    async function post(texts) {
      const r = await fetch("/api/translate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, source, target }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || ("HTTP " + r.status)); }
      return (await r.json()).translations || [];
    }
    try {
      const hasQuiz = Array.isArray(ch.quiz) && ch.quiz.length;
      const hasCards = Array.isArray(ch.cards) && ch.cards.length;
      const hasTermes = Array.isArray(ch.termes) && ch.termes.length;
      const total = ch.sections.length + 1 + (hasQuiz ? 1 : 0) + (hasCards ? 1 : 0) + (hasTermes ? 1 : 0);
      let step = 0;
      const head = await post([ch.titre || "", ch.theme || ""]);
      const t = { titre: head[0] || ch.titre, theme: head[1] != null ? head[1] : ch.theme, sections: {} };
      if (onProgress) onProgress(++step, total);
      for (const s of ch.sections) {
        const out = await post([s.titre || "", s.contenu || ""]);
        t.sections[s.n] = { titre: out[0] || s.titre, contenu: out[1] != null ? out[1] : s.contenu };
        if (onProgress) onProgress(++step, total);
      }
      // quiz: q + options + explication per question (keep `correct` index)
      if (hasQuiz) {
        const qt = [], shape = [];
        ch.quiz.forEach(q => { const o = q.options || []; shape.push(o.length); qt.push(q.q || ""); o.forEach(x => qt.push(x || "")); qt.push(q.explication || ""); });
        const out = await post(qt);
        let k = 0;
        t.quiz = ch.quiz.map((q, i) => {
          const qq = out[k++] || q.q; const opts = [];
          for (let j = 0; j < shape[i]; j++) opts.push(out[k++]);
          const ex = out[k++];
          return { q: qq, options: opts, explication: ex != null ? ex : q.explication };
        });
        if (onProgress) onProgress(++step, total);
      }
      // flashcards: recto + verso
      if (hasCards) {
        const ct = []; ch.cards.forEach(c => { ct.push(c.recto || ""); ct.push(c.verso || ""); });
        const out = await post(ct);
        t.cards = ch.cards.map((c, i) => ({ recto: out[2 * i] || c.recto, verso: out[2 * i + 1] != null ? out[2 * i + 1] : c.verso }));
        if (onProgress) onProgress(++step, total);
      }
      // glossary: translate the explanation/translation, KEEP the German term (.de)
      if (hasTermes) {
        const gt = []; ch.termes.forEach(tm => { gt.push(tm.fr || ""); gt.push(tm.translation || ""); gt.push(tm.def || ""); });
        const out = await post(gt);
        t.termes = ch.termes.map((tm, i) => ({ fr: out[3 * i] || tm.fr, translation: out[3 * i + 1] != null ? out[3 * i + 1] : tm.translation, def: out[3 * i + 2] != null ? out[3 * i + 2] : tm.def }));
        if (onProgress) onProgress(++step, total);
      }
      patchChapter(chapterId, c => ({ i18n: { ...(c.i18n || {}), [target]: t }, lang: c.lang || source }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /* ---- contextual Q&A: chapter.insertions[] (never touches lesson markdown) ---- */
  function addInsertion(chapterId, partial) {
    const insertion = { id: newInsertionId(), addedToCards: false, addedToQuiz: false, createdAt: Date.now(), ...partial };
    patchChapter(chapterId, c => ({ insertions: [...(c.insertions || []), insertion] }));
  }
  function deleteInsertion(chapterId, insertionId, alsoRemoveBankItem) {
    setChapters(prev => prev.map(c => {
      if (c.id !== chapterId) return c;
      const ins = (c.insertions || []).find(x => x.id === insertionId);
      let cards = c.cards, quiz = c.quiz;
      if (alsoRemoveBankItem && ins) {
        if (ins.addedToCards && Array.isArray(cards)) cards = cards.filter(card => card.recto !== ins.addedToCards);
        if (ins.addedToQuiz && Array.isArray(quiz)) quiz = quiz.filter(q => q.q !== ins.addedToQuiz);
      }
      return { ...c, cards, quiz, insertions: (c.insertions || []).filter(x => x.id !== insertionId) };
    }));
  }

  /* ---- "hide passage": chapter.hiddenBlocks[] (course markdown never touched, mirrors insertions[]) ---- */
  function addHiddenBlock(chapterId, partial) {
    const hidden = { id: newHiddenId(), createdAt: Date.now(), ...partial };
    patchChapter(chapterId, c => ({ hiddenBlocks: [...(c.hiddenBlocks || []), hidden] }));
  }
  function restoreHiddenBlock(chapterId, hiddenId) {
    patchChapter(chapterId, c => ({ hiddenBlocks: (c.hiddenBlocks || []).filter(x => x.id !== hiddenId) }));
  }
  async function checkAndAddToBank(chapterId, passage, insertionId) {
    const ch = chaptersRef.current.find(c => c.id === chapterId); if (!ch) return;
    try {
      const data = window.parseJSON(await window.callClaude(window.buildBankCheckPrompt(ch, passage)));
      if (!data) { flash("Erreur : réponse illisible du moteur."); return; }
      let cardMsg = "", quizMsg = "", addedCardTitle = false, addedQuizTitle = false;
      if (data.card) {
        if (data.card.déjàCouvert) cardMsg = "Déjà couvert par la carte « " + (data.card.doublonDe || "?") + " »";
        else if (data.card.recto && data.card.verso) {
          patchChapter(chapterId, c => ({ cards: [...(c.cards || []), { recto: data.card.recto, verso: data.card.verso }] }));
          cardMsg = "Nouvelle flashcard ajoutée"; addedCardTitle = data.card.recto;
        }
      }
      if (data.quiz) {
        if (data.quiz.déjàCouvert) quizMsg = "Déjà couvert par la question « " + (data.quiz.doublonDe || "?") + " »";
        else if (data.quiz.q && Array.isArray(data.quiz.options) && data.quiz.options.length >= 2) {
          patchChapter(chapterId, c => ({ quiz: [...(c.quiz || []), { q: data.quiz.q, options: data.quiz.options, correct: data.quiz.correct || 0, explication: data.quiz.explication || "" }] }));
          quizMsg = "Nouvelle question de quiz ajoutée"; addedQuizTitle = data.quiz.q;
        }
      }
      if (insertionId && (addedCardTitle || addedQuizTitle)) {
        patchChapter(chapterId, c => ({
          insertions: (c.insertions || []).map(ins => ins.id === insertionId
            ? { ...ins, addedToCards: addedCardTitle || ins.addedToCards, addedToQuiz: addedQuizTitle || ins.addedToQuiz }
            : ins),
        }));
      }
      flash([cardMsg, quizMsg].filter(Boolean).join(" · ") || "Rien à ajouter — déjà couvert.");
    } catch (e) { flash("Échec de la vérification : " + ((e && e.message) || String(e))); }
  }

  /* ---- generation ---- */
  async function generateChapter(source, fromFile, images) {
    if (!aiReady) { setShowSettings(true); return; }
    const ch = freshChapter(source, fromFile, images);
    (ch.figures || []).forEach(f => { if (f.url && window.registerFigImage) window.registerFigImage(ch.id, f.id, f.url); });
    uploadFigures(ch.id, ch.figures);   // persist images out-of-band (survives reload + syncs across devices)
    setChapters(prev => [...prev, ch]);
    setCurrentId(ch.id);
    setHome(false);
    setTab("learn");
    setGenerating(true);
    cancelRef.current = false;
    const id = ch.id;

    try {
      const raw = await window.callClaude(window.buildIntroPrompt(ch));
      const data = window.parseJSON(raw) || {};
      patchChapter(id, {
        titre: data.titre || "Chapitre", theme: data.theme || "",
        langueSource: data.langueSource || "", lisible: data.lisible !== false,
        manque: data.manque || "", termes: Array.isArray(data.termes) ? data.termes : [],
      });
      if (data.lisible === false) { patchChapter(id, { status: "done" }); setGenerating(false); return; }
    } catch (e) { patchChapter(id, { titre: "Chapitre", lisible: true }); }

    const withTermes = () => chaptersRef.current.find(c => c.id === id) || ch;
    const prior = window.buildPriorContext(chaptersRef.current, id);
    const enabledNums = window.getEnabledSections();
    const sectionsToGen = window.SECTIONS.filter(s => enabledNums.includes(s.n));

    // Mark all non-exercise sections as loading upfront so the user sees all spinners at once
    sectionsToGen.forEach(s => { if (s.n !== 7) patchSection(id, s.n, { status: "loading" }); });

    // Build task list: sections + exercises + quiz + cards — all run in the same pool
    const tasks = [];
    for (const s of sectionsToGen) {
      const sn = s.n;
      if (sn === 7) {
        tasks.push(() => generateExercises(id, prior));
      } else {
        tasks.push(async () => {
          try {
            let acc = "";
            let timer = null;
            // Throttle React re-renders to at most every 80ms while streaming
            const flush = () => { timer = null; patchSection(id, sn, { status: "loading", contenu: acc }); };
            const schedule = () => { if (!timer) timer = setTimeout(flush, 80); };
            const chapterNow = withTermes();
            const vision = await window.prepareVisionContext(chapterNow, sn);
            await window.callClaudeStream(
              window.buildSectionPrompt(chapterNow, sn, prior, vision),
              undefined,
              (chunk) => { acc += chunk; schedule(); },
              vision && vision.images
            );
            if (timer) { clearTimeout(timer); }
            patchSection(id, sn, acc.length > 2 ? { status: "done", contenu: acc } : { status: "error", err: "Réponse vide du moteur." });
          } catch (e) { patchSection(id, sn, { status: "error", err: (e && e.message) || String(e) }); }
        });
      }
    }
    tasks.push(() => genQuiz(id));
    tasks.push(() => genCards(id));

    // 3 concurrent requests — safe within OpenRouter's 15 req/min free tier
    await runConcurrent(tasks, 3, () => cancelRef.current);
    if (cancelRef.current) {
      // user stopped: anything still "loading" without content becomes a retry-able stopped state
      setChapters(prev => prev.map(c => c.id !== id ? c : {
        ...c, status: "done",
        sections: c.sections.map(s => (s.status === "loading" && !(s.contenu && s.contenu.length > 2))
          ? { ...s, status: "error", err: window.ui("genStoppedSection") } : s),
      }));
      setGenerating(false);
      return;
    }
    try {
      const raw = await window.callClaude(window.buildClosingPrompt(withTermes()));
      const data = window.parseJSON(raw) || {};
      patchChapter(id, { aVerifier: Array.isArray(data.aVerifier) ? data.aVerifier : [], prochaineEtape: data.prochaineEtape || "" });
    } catch (e) {}
    patchChapter(id, { status: "done" });
    setGenerating(false);
  }

  async function genQuiz(id) {
    const ch = chaptersRef.current.find(c => c.id === id); if (!ch) return;
    patchChapter(id, { quizStatus: "loading" });
    try {
      const data = window.parseJSON(await window.callClaude(window.buildQuizPrompt(ch)));
      const quiz = data && Array.isArray(data.quiz) ? data.quiz.filter(q => q && q.options && q.options.length >= 2) : [];
      patchChapter(id, { quiz, quizStatus: "done" });
    } catch (e) { patchChapter(id, { quizStatus: "error", quizErr: (e && e.message) || String(e) }); }
  }
  async function genCards(id) {
    const ch = chaptersRef.current.find(c => c.id === id); if (!ch) return;
    patchChapter(id, { cardsStatus: "loading" });
    try {
      const data = window.parseJSON(await window.callClaude(window.buildFlashPrompt(ch)));
      const cards = data && Array.isArray(data.cards) ? data.cards.filter(c => c && c.recto && c.verso) : [];
      patchChapter(id, { cards, cardsStatus: "done" });
    } catch (e) { patchChapter(id, { cardsStatus: "error", cardsErr: (e && e.message) || String(e) }); }
  }
  /* Section 7 — detect ALL exercises, then solve each in its own full-budget pass */
  async function generateExercises(id, prior) {
    patchSection(id, 7, { status: "loading", contenu: "" });
    const ch = chaptersRef.current.find(c => c.id === id); if (!ch) return;
    let list = [];
    try {
      const d = window.parseJSON(await window.callClaude(window.buildExerciseListPrompt(ch)));
      list = d && Array.isArray(d.exercices) ? d.exercices : [];
    } catch (e) {}
    if (!list.length) {
      try {
        const txt = await window.callClaude(window.buildNoExercisePrompt(ch, prior));
        patchSection(id, 7, txt && txt.length > 2 ? { status: "done", contenu: txt } : { status: "error", err: "Réponse vide du moteur." });
      } catch (e) { patchSection(id, 7, { status: "error", err: (e && e.message) || String(e) }); }
      return;
    }
    const cap = Math.min(list.length, 12);
    let acc = "";
    for (let i = 0; i < cap; i++) {
      if (cancelRef.current) break;
      const ex = list[i];
      try {
        const txt = await window.callClaude(window.buildSingleExercisePrompt(ch, ex, prior, i + 1, cap));
        acc += (acc ? "\n\n" : "") + (txt || "").trim();
      } catch (e) {
        acc += (acc ? "\n\n" : "") + "#### Exercice " + (ex.ref || (i + 1)) + "\n*(génération interrompue — utilise « Réessayer »)*";
      }
      patchSection(id, 7, { status: "loading", contenu: acc });
    }
    patchSection(id, 7, { status: "done", contenu: acc });
  }

  async function retrySection(id, n) {
    if (generating) return; setGenerating(true);
    if (n === 7) { await generateExercises(id, window.buildPriorContext(chaptersRef.current, id)); setGenerating(false); return; }
    const chForRetry = chaptersRef.current.find(c => c.id === id);
    if (!chForRetry) { setGenerating(false); return; }
    patchSection(id, n, { status: "loading" });
    try {
      const vision = await window.prepareVisionContext(chForRetry, n);
      const prior = window.buildPriorContext(chaptersRef.current, id);
      const txt = await window.callClaude(window.buildSectionPrompt(chForRetry, n, prior, vision), undefined, vision && vision.images);
      patchSection(id, n, txt && txt.length > 2 ? { status: "done", contenu: txt } : { status: "error", err: "Réponse vide du moteur." });
    } catch (e) { patchSection(id, n, { status: "error", err: (e && e.message) || String(e) }); }
    setGenerating(false);
  }
  async function retryQuiz(id) { if (generating) return; setGenerating(true); await genQuiz(id); setGenerating(false); }
  async function retryCards(id) { if (generating) return; setGenerating(true); await genCards(id); setGenerating(false); }

  function deleteChapter(id) {
    const ch = chaptersRef.current.find(c => c.id === id);
    setChapters(prev => {
      const next = prev.filter(c => c.id !== id);
      if (currentId === id) setCurrentId(next.length ? next[next.length - 1].id : null);
      return next;
    });
    if (ch) {
      setUndo({ ch });
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), 6000);
    }
  }
  function renameChapter(id, titre) { patchChapter(id, { titre: titre }); }
  function toggleMastered(id) {
    const ch = chaptersRef.current.find(c => c.id === id);
    const becoming = !(ch && ch.mastered);
    patchChapter(id, c => ({ mastered: !c.mastered, masteredAt: !c.mastered ? Date.now() : c.masteredAt }));
    logProgress({ type: becoming ? "master" : "unmaster", courseId: id });
  }
  function onQuizDone(courseId, score, total) {
    if (!total) return;
    logProgress({ type: "quiz", courseId, score, total });
  }

  /* Pull a course's images into the registry (data URIs) so an export can embed
     them — they no longer live in the state blob, only on the server. */
  async function ensureCourseFigures(ch) {
    const figs = (ch && ch.figures) || [];
    await Promise.all(figs.map(async f => {
      if (!f || !f.id) return;
      const key = window.figKey(ch.id, f.id);
      if (window.HML_FIGS[key]) return;
      try {
        const r = await fetch("/api/figures/" + encodeURIComponent(ch.id) + "/" + encodeURIComponent(f.id));
        if (!r.ok) return;
        const blob = await r.blob();
        const uri = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
        if (uri) window.HML_FIGS[key] = uri;
      } catch (_) {}
    }));
  }

  async function downloadChapter(id) {
    const ch = chaptersRef.current.find(c => c.id === id); if (!ch) return;
    try {
      flash("Préparation du téléchargement…");
      await ensureCourseFigures(ch);
      window.downloadFile(window.safeName(ch.titre) + ".html", window.buildExportHTML(ch), "text/html;charset=utf-8");
      flash("Cours téléchargé (HTML, images incluses).");
    } catch (e) { flash("Échec du téléchargement."); }
  }

  /* One-click PDF: build the standalone HTML (images embedded), open it and
     trigger the browser print dialog → "Enregistrer en PDF". */
  async function downloadPDF(id) {
    const ch = chaptersRef.current.find(c => c.id === id); if (!ch) return;
    flash("Préparation du PDF…");
    try {
      await ensureCourseFigures(ch);
      const html = window.buildExportHTML(ch);
      const w = window.open("", "_blank");
      if (!w) { flash("Autorise les pop-ups pour générer le PDF."); return; }
      w.document.open(); w.document.write(html); w.document.close();
      const go = () => { try { w.focus(); w.print(); } catch (_) {} };
      w.onload = () => setTimeout(go, 500);
      setTimeout(go, 1200);   // fallback if onload already fired
      flash("Dans la fenêtre d'impression, choisis « Enregistrer en PDF ».");
    } catch (e) { flash("Échec de l'export PDF."); }
  }

  /* Recover a course's ORIGINAL images by re-importing its PDF: re-extract,
     remap each image to the existing figure id (same page, nearest size) and
     upload it — so the course + its progress are preserved, no regeneration. */
  /* The figure ids a course references in its prose, in reading order — mirrors
     how the renderer / HTML export walk [img:fN] lines and ```img``` fences. */
  function orderedFigIds(ch) {
    const ids = [];
    (ch.sections || []).forEach(s => {
      const lines = (s.contenu || "").replace(/\r/g, "").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const il = lines[i].match(/^\s*\[img:\s*(f\d+)\s*\]/i);
        if (il) { ids.push(il[1]); continue; }
        if (lines[i].trim().startsWith("```")) {
          const lang = lines[i].trim().slice(3).trim().toLowerCase();
          const buf = []; i++;
          while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i++; }
          if (lang === "img") { const r = window.parseImgRef(buf.join("\n")); if (r && r.id) ids.push(r.id); }
        }
      }
    });
    return ids;
  }

  /* Recover images from a previously-downloaded HTML export: it already embeds
     the original images in prose order, so zip them to the course's ordered
     figure ids. More reliable than PDF re-extraction (exact originals, no
     re-detection) — and works when the source PDF is gone. */
  async function recoverFromHTML(ch, oldFigs, file) {
    flash("Lecture du HTML…");
    const html = await file.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    let imgs = [...doc.querySelectorAll("figure.course-fig img")].map(im => im.getAttribute("src"));
    if (!imgs.length) imgs = [...doc.querySelectorAll('img[src^="data:image"]')].map(im => im.getAttribute("src"));
    imgs = imgs.filter(s => s && s.startsWith("data:image"));
    const ids = orderedFigIds(ch);
    const n = Math.min(ids.length, imgs.length);
    if (!n) { flash("Aucune image intégrée trouvée dans ce HTML."); return; }
    const uploads = [];
    for (let i = 0; i < n; i++) { uploads.push({ id: ids[i], url: imgs[i] }); if (window.registerFigImage) window.registerFigImage(ch.id, ids[i], imgs[i]); }
    await uploadFigures(ch.id, uploads);
    setChapters(prev => prev.slice());   // re-render so figures pick up the recovered images
    const warn = (imgs.length !== ids.length) ? " · " + imgs.length + " img/" + ids.length + " réf — vérifie" : "";
    flash(uploads.length + "/" + oldFigs.length + " image" + (oldFigs.length > 1 ? "s" : "") + " récupérée" + (uploads.length > 1 ? "s" : "") + " ✓" + warn);
  }

  function recoverImages(ch) {
    const oldFigs = (ch && ch.figures) || [];
    if (!oldFigs.length) { flash("Ce cours n'a pas de figures à récupérer."); return; }
    const input = document.createElement("input");
    input.type = "file"; input.accept = "application/pdf,.pdf,text/html,.html,.htm";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (/\.html?$/i.test(file.name || "") || file.type === "text/html") { try { await recoverFromHTML(ch, oldFigs, file); } catch (e) { flash("Echec HTML : " + ((e && e.message) || e)); } return; }
      flash("Lecture du PDF…");
      try {
        const res = await window.extractFromPDF(file, (s) => setToast(s));
        const newFigs = (res && res.images) || [];
        if (!newFigs.length) { flash("Aucune image trouvée dans ce PDF."); return; }
        const used = new Set(), uploads = [];
        oldFigs.forEach(of => {
          let best = -1, bestScore = Infinity;
          newFigs.forEach((nf, i) => {
            if (used.has(i) || !nf.url || nf.page !== of.page) return;
            const score = Math.abs((nf.w || 0) - (of.w || 0)) + Math.abs((nf.h || 0) - (of.h || 0));
            if (score < bestScore) { bestScore = score; best = i; }
          });
          if (best >= 0) { used.add(best); uploads.push({ id: of.id, url: newFigs[best].url }); if (window.registerFigImage) window.registerFigImage(ch.id, of.id, newFigs[best].url); }
        });
        if (!uploads.length) { flash("Aucune image n'a pu être associée — est-ce bien le PDF de ce cours ?"); return; }
        await uploadFigures(ch.id, uploads);
        setChapters(prev => prev.slice());   // re-render so figures pick up the recovered images
        flash(uploads.length + "/" + oldFigs.length + " image" + (oldFigs.length > 1 ? "s" : "") + " récupérée" + (uploads.length > 1 ? "s" : "") + " ✓");
      } catch (e) { flash("Échec : " + ((e && e.message) || e)); }
    };
    input.click();
  }

  function openCourse(id, t) { setCurrentId(id); setHome(false); setTab(t || "learn"); }
  function newCourse() { setHome(true); setTab("learn"); }

  const counts = {
    library: chapters.length,
    quiz: chapters.reduce((a, c) => a + (c.quiz ? c.quiz.length : 0), 0),
    cards: chapters.reduce((a, c) => a + (c.cards ? c.cards.length : 0), 0),
  };

  const doneSections = current ? current.sections.filter(s => s.status === "done").length : 0;

  return (
    <div className="shell" data-nav={navClosed ? "closed" : "open"}>
      {/* ---------- SIDEBAR ---------- */}
      <aside className="sidebar">
        <div className="side-brand">
          <div className="brand-mark brand-mark--logo"><window.BrandMark size={42} /></div>
          <div className="brand-text">
            <span className="brand-title">Learniverse</span>
            <span className="brand-sub">ton univers d'apprentissage</span>
          </div>
          <button className="nav-collapse" onClick={toggleNav} aria-label={window.ui("navCollapse")} title={window.ui("navCollapse")}>
            <AIcon name="sidebar" size={17} />
          </button>
        </div>
        {TABS.map(t => (
          <button key={t.id} className="nav-item" aria-selected={tab === t.id} onClick={() => { setTab(t.id); if (t.id === "learn" && !current) setHome(true); }}>
            <span className="nav-ico"><AIcon name={t.icon} size={19} /></span>
            <span className="nav-label">{t.label}</span>
            {counts[t.id] > 0 && <span className="nav-badge">{counts[t.id]}</span>}
            {t.id === "learn" && generating && <span className="nav-badge"><Spinner size={12} /></span>}
          </button>
        ))}
        <div className="side-foot">
          <button className="btn btn-primary btn-sm" onClick={newCourse} style={{ justifyContent: "center" }}>
            <AIcon name="plusbig" size={15} /> {window.ui("btnNewCourse")}
          </button>
          {generating && (current
            ? <GenTimeline chapter={current} />
            : <div className="gen-chip"><Spinner size={14} /> {window.ui("generating")}</div>
          )}
          {generating && (
            <button className="btn btn-sm" onClick={stopGeneration}
              style={{ justifyContent: "center", color: "var(--bad)", borderColor: "color-mix(in oklch, var(--bad) 35%, transparent)", background: "var(--bad-soft)" }}>
              <AIcon name="x" size={13} /> {window.ui("btnStopGen")}
            </button>
          )}
          <button className="theme-btn" onClick={() => setShowSettings(true)} title="Choisir le moteur d'IA">
            <span style={{ width: 9, height: 9, borderRadius: 99, flex: "none", background: provider === "claude" ? "var(--accent)" : "var(--good)" }} />
            {provider === "claude" ? window.ui("engineClaude") : provider === "gemini" ? window.ui("engineGemini") : window.ui("engineOllama")}
          </button>
          <button className="theme-btn" onClick={() => setShowPrefs(true)} title={window.ui("prefsTitle")}>
            <AIcon name="target" size={15} />
            {window.ui("btnPrefs")}
          </button>
          <button className="theme-btn" onClick={() => setShowDiag(true)} title={window.ui("diagBtn")}>
            <AIcon name="warn" size={15} />
            {window.ui("diagBtn")}
            {diagErrors > 0 && <span className="nav-badge" style={{ marginLeft: "auto", background: "var(--bad)", color: "#fff" }}>{diagErrors}</span>}
          </button>
          <div className="acct-wrap" style={{ position: "relative" }}>
            <button className="theme-btn" onClick={onAccountClick} style={{ width: "100%" }}
              title={user ? "Compte" : "Se connecter pour synchroniser tes cours"}>
              <AIcon name="user" size={15} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user ? user.email : "Se connecter"}
              </span>
              {user && <AIcon name="chevrondown" size={13} style={{ marginLeft: "auto", opacity: 0.6 }} />}
            </button>
            {user && acctOpen && (
              <div className="acct-pop acct-pop--up">
                <div className="acct-pop-head">Connecté en tant que<br /><span className="mono">{user.email}</span></div>
                <button className="acct-logout" onClick={() => { setAcctOpen(false); logout(); }}>
                  <AIcon name="logout" size={15} /> Se déconnecter
                </button>
              </div>
            )}
          </div>
          <button className="theme-btn" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>
            <AIcon name={theme === "dark" ? "sun" : "moon"} size={16} />
            {theme === "dark" ? window.ui("themeDark") : window.ui("themeLight")}
          </button>
        </div>
      </aside>

      {/* floating button to bring the sidebar back (desktop, only when closed) */}
      <button className="nav-reopen" onClick={toggleNav} aria-label={window.ui("navExpand")} title={window.ui("navExpand")}>
        <AIcon name="sidebar" size={18} />
      </button>

      {/* ---------- CONTENT ---------- */}
      <div className="content">
        <div className="mobile-top">
          <div className="brand-mark brand-mark--logo" style={{ width: 34, height: 34 }}><window.BrandMark size={34} /></div>
          <div className="brand-text">
            <span className="brand-title" style={{ fontSize: 16 }}>Learniverse</span>
          </div>
          {generating && (
            <button className="icon-btn" onClick={stopGeneration} aria-label={window.ui("btnStopGen")} title={window.ui("btnStopGen")} style={{ color: "var(--bad)" }}>
              <AIcon name="x" size={17} />
            </button>
          )}
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Moteur d'IA" title="Choisir le moteur d'IA" style={{ position: "relative" }}>
            <AIcon name="spark" size={17} />
            <span style={{ position: "absolute", top: 6, right: 6, width: 8, height: 8, borderRadius: 99, background: provider === "claude" ? "var(--accent)" : provider === "gemini" ? "var(--good)" : "var(--ochre)", border: "1.5px solid var(--surface)" }} />
          </button>
          <button className="icon-btn" onClick={() => setShowPrefs(true)} aria-label={window.ui("btnPrefs")} title={window.ui("prefsTitle")}>
            <AIcon name="target" size={17} />
          </button>
          <button className="icon-btn" onClick={() => setShowDiag(true)} aria-label={window.ui("diagBtn")} title={window.ui("diagBtn")} style={{ position: "relative" }}>
            <AIcon name="warn" size={17} />
            {diagErrors > 0 && <span style={{ position: "absolute", top: 4, right: 4, minWidth: 14, height: 14, padding: "0 3px", borderRadius: 99, background: "var(--bad)", color: "#fff", fontSize: 9, lineHeight: "14px", textAlign: "center" }}>{diagErrors}</span>}
          </button>
          <div className="acct-wrap" style={{ position: "relative" }}>
            <button className="icon-btn" onClick={onAccountClick} style={{ position: "relative" }}
              aria-label={user ? "Compte" : "Se connecter"} title={user ? user.email : "Se connecter"}>
              <AIcon name="user" size={17} />
              {user && <span style={{ position: "absolute", top: 6, right: 6, width: 8, height: 8, borderRadius: 99, background: "var(--good)", border: "1.5px solid var(--surface)" }} />}
            </button>
            {user && acctOpen && (
              <div className="acct-pop acct-pop--down">
                <div className="acct-pop-head">Connecté en tant que<br /><span className="mono">{user.email}</span></div>
                <button className="acct-logout" onClick={() => { setAcctOpen(false); logout(); }}>
                  <AIcon name="logout" size={15} /> Se déconnecter
                </button>
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} aria-label="Thème">
            <AIcon name={theme === "dark" ? "sun" : "moon"} size={17} />
          </button>
        </div>
        {!serverOnline && (
          <div className="offline-banner">
            <AIcon name="warn" size={16} />
            <span style={{ flex: 1 }}>{window.ui("offlineBanner")}</span>
            <button className="btn btn-sm" onClick={() => window.location.reload()}>{window.ui("btnReload")}</button>
          </div>
        )}
        <main className="content-inner">
          {tab === "learn" && <LearnTab chapters={chapters} current={currentView} generating={generating} home={home} aiReady={aiReady} onOpenSettings={() => setShowSettings(true)} onGenerate={generateChapter} onRetrySection={retrySection} onSelect={(id) => { setCurrentId(id); setHome(false); }} onDownload={downloadChapter} onAddInsertion={addInsertion} onDeleteInsertion={deleteInsertion} onCheckBank={checkAndAddToBank} onAddHiddenBlock={addHiddenBlock} onRestoreHiddenBlock={restoreHiddenBlock} onTranslate={translateChapter} onSetDisplayLang={setChapterLang} />}
          {tab === "library" && <LibraryTab chapters={chapters} onOpen={openCourse} onToggleMastered={toggleMastered} onDelete={deleteChapter} onDownload={downloadChapter} onDownloadPDF={downloadPDF} onNew={newCourse} onRecoverImages={recoverImages} onRename={renameChapter} />}
          {tab === "quiz" && <QuizTab chapters={chapters} current={currentView} onSelect={setCurrentId} onRetry={retryQuiz} generating={generating} onQuizComplete={onQuizDone} />}
          {tab === "cards" && <FlashTab chapters={chapters} current={currentView} onSelect={setCurrentId} onRetry={retryCards} generating={generating} />}
          {tab === "progress" && <window.ProgressDashboard chapters={chapters} progressLog={progressLog} onOpen={openCourse} />}
          {tab === "plan" && <PlanTab chapters={chapters} planDays={planDays} />}
        </main>
      </div>

      {/* ---------- API KEY MODAL ---------- */}
      <ApiKeyModal open={showSettings} onClose={closeSettings} />

      {/* ---------- PREFS MODAL ---------- */}
      <PrefsModal open={showPrefs} onClose={closePrefs} />

      {/* ---------- DIAGNOSTICS MODAL ---------- */}
      <window.DiagnosticsModal open={showDiag} onClose={() => setShowDiag(false)} />

      {/* ---------- AUTH MODAL ---------- */}
      <AuthModal open={showAuth} onClose={() => setShowAuth(false)} onAuthed={setUser} />
      {resetToken && <ResetModal token={resetToken} onClose={() => setResetToken("")} />}

      {/* ---------- TOAST ---------- */}
      {toast && (
        <div className="fade-in" style={{ position: "fixed", bottom: 26, left: "50%", transform: "translateX(-50%)", zIndex: 100,
          background: "var(--surface)", border: "1px solid var(--line)", boxShadow: "var(--shadow-lg)",
          borderRadius: 12, padding: "12px 18px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 10, maxWidth: "90vw" }}>
          <span style={{ color: "var(--good)" }}><AIcon name="check" size={17} /></span>{toast}
        </div>
      )}

      {/* ---------- UNDO DELETE ---------- */}
      {undo && undo.ch && (
        <div className="fade-in" style={{ position: "fixed", bottom: 26, left: "50%", transform: "translateX(-50%)", zIndex: 101,
          background: "var(--surface)", border: "1px solid var(--line-strong)", boxShadow: "var(--shadow-lg)",
          borderRadius: 12, padding: "10px 12px 10px 16px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 12, maxWidth: "90vw" }}>
          <span>{window.ui("courseDeleted")}</span>
          <button className="btn btn-sm" onClick={undoDelete}><AIcon name="flip" size={13} /> {window.ui("btnUndo")}</button>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);