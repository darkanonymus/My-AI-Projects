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
async function runConcurrent(tasks, limit) {
  const queue = [...tasks];
  async function worker() {
    while (queue.length) { const t = queue.shift(); if (t) await t(); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const LS_KEY = "hml_state_v2";
let CH_SEQ = 1;

function newId() { return "ch" + (CH_SEQ++); }
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
    // restore figure-id sequence + re-register original course images
    let fmax = 0;
    window.HML_FIGS = window.HML_FIGS || {};
    d.chapters.forEach(c => (c.figures || []).forEach(f => {
      const fm = /f(\d+)/.exec(f.id || ""); if (fm) fmax = Math.max(fmax, +fm[1]);
      if (f.url && window.registerFigImage) window.registerFigImage(f.id, f.url);
    }));
    window.FIG_SEQ = Math.max(window.FIG_SEQ || 1, fmax + 1);
    return d;
  } catch (e) { return null; }
}
const SAVED = loadState();

function App() {
  const [theme, setTheme] = uS((SAVED && SAVED.theme) || "dark");
  const [tab, setTab] = uS(SAVED && SAVED.chapters && SAVED.chapters.length ? "library" : "learn");
  const [chapters, setChapters] = uS(SAVED ? SAVED.chapters : []);
  const [currentId, setCurrentId] = uS(SAVED ? SAVED.currentId : null);
  const [home, setHome] = uS(!(SAVED && SAVED.chapters && SAVED.chapters.length));
  const [generating, setGenerating] = uS(false);
  const [toast, setToast] = uS("");
  const [provider, setProviderState] = uS(window.getProvider());
  const [showSettings, setShowSettings] = uS(false);
  const [showPrefs, setShowPrefs] = uS(false);
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
      localStorage.setItem(LS_KEY, JSON.stringify({ chapters, currentId, theme }));
    } catch (e) {
      try {
        const light = { chapters: chapters.map(c => ({ ...c, figures: (c.figures || []).map(f => ({ id: f.id, page: f.page, w: f.w, h: f.h })) })), currentId, theme };
        localStorage.setItem(LS_KEY, JSON.stringify(light));
      } catch (_) { /* still over quota — keep text in memory only */ }
    }
  }, [chapters, currentId, theme]);

  /* keep the original-image registry in sync so ```img``` blocks resolve */
  uE(() => {
    if (!window.registerFigImage) return;
    chapters.forEach(c => (c.figures || []).forEach(f => { if (f.url) window.registerFigImage(f.id, f.url); }));
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
          setChapters(serverChs);
          if (serverState.currentId) setCurrentId(serverState.currentId);
          if (serverState.theme)     setTheme(serverState.theme);
          if (!serverChs.length) { setHome(true); setTab("learn"); }
        } else if (localChs.length > serverChs.length) {
          // Local has more chapters — push local state to server to update it
          fetch("/api/state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data: JSON.stringify({ chapters: localChs, currentId, theme }) }),
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
        body: JSON.stringify({ data: JSON.stringify({ chapters, currentId, theme }) }),
      }).catch(() => {});
    }, 2500); // debounce 2.5s after last change
    return () => { if (_saveTimer.current) clearTimeout(_saveTimer.current); };
  }, [chapters, currentId, theme]);

  const current = chapters.find(c => c.id === currentId) || null;

  function patchChapter(id, patch) {
    setChapters(prev => prev.map(c => c.id === id ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c));
  }
  function patchSection(id, n, patch) {
    setChapters(prev => prev.map(c => c.id !== id ? c : { ...c, sections: c.sections.map(s => s.n === n ? { ...s, ...patch } : s) }));
  }
  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 2600); }

  /* ---- generation ---- */
  async function generateChapter(source, fromFile, images) {
    if (!aiReady) { setShowSettings(true); return; }
    const ch = freshChapter(source, fromFile, images);
    (ch.figures || []).forEach(f => { if (f.url && window.registerFigImage) window.registerFigImage(f.id, f.url); });
    setChapters(prev => [...prev, ch]);
    setCurrentId(ch.id);
    setHome(false);
    setTab("learn");
    setGenerating(true);
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
            await window.callClaudeStream(
              window.buildSectionPrompt(withTermes(), sn, prior),
              undefined,
              (chunk) => { acc += chunk; schedule(); }
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
    await runConcurrent(tasks, 3);
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
      const txt = await window.callClaude(window.buildSectionPrompt(chForRetry, n, window.buildPriorContext(chaptersRef.current, id)));
      patchSection(id, n, txt && txt.length > 2 ? { status: "done", contenu: txt } : { status: "error", err: "Réponse vide du moteur." });
    } catch (e) { patchSection(id, n, { status: "error", err: (e && e.message) || String(e) }); }
    setGenerating(false);
  }
  async function retryQuiz(id) { if (generating) return; setGenerating(true); await genQuiz(id); setGenerating(false); }
  async function retryCards(id) { if (generating) return; setGenerating(true); await genCards(id); setGenerating(false); }

  function deleteChapter(id) {
    setChapters(prev => {
      const next = prev.filter(c => c.id !== id);
      if (currentId === id) setCurrentId(next.length ? next[next.length - 1].id : null);
      return next;
    });
  }
  function toggleMastered(id) { patchChapter(id, c => ({ mastered: !c.mastered })); }

  function downloadChapter(id) {
    const ch = chaptersRef.current.find(c => c.id === id); if (!ch) return;
    try {
      window.downloadFile(window.safeName(ch.titre) + ".html", window.buildExportHTML(ch), "text/html;charset=utf-8");
      flash("Cours téléchargé — ouvre-le, puis imprime-le en PDF si tu veux.");
    } catch (e) { flash("Échec du téléchargement."); }
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
    <div className="shell">
      {/* ---------- SIDEBAR ---------- */}
      <aside className="sidebar">
        <div className="side-brand">
          <div className="brand-mark">L</div>
          <div className="brand-text">
            <span className="brand-title">Help me Learn</span>
            <span className="brand-sub">IA · KI</span>
          </div>
        </div>
        <div className="side-label">{window.ui("navLabel")}</div>
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
          <button className="theme-btn" onClick={() => setShowSettings(true)} title="Choisir le moteur d'IA">
            <span style={{ width: 9, height: 9, borderRadius: 99, flex: "none", background: provider === "claude" ? "var(--accent)" : "var(--good)" }} />
            {provider === "claude" ? window.ui("engineClaude") : provider === "gemini" ? window.ui("engineGemini") : window.ui("engineOllama")}
          </button>
          <button className="theme-btn" onClick={() => setShowPrefs(true)} title={window.ui("prefsTitle")}>
            <AIcon name="target" size={15} />
            {window.ui("btnPrefs")}
          </button>
          <button className="theme-btn" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>
            <AIcon name={theme === "dark" ? "sun" : "moon"} size={16} />
            {theme === "dark" ? window.ui("themeDark") : window.ui("themeLight")}
          </button>
        </div>
      </aside>

      {/* ---------- CONTENT ---------- */}
      <div className="content">
        <div className="mobile-top">
          <div className="brand-mark" style={{ width: 34, height: 34, fontSize: 17 }}>L</div>
          <div className="brand-text">
            <span className="brand-title" style={{ fontSize: 16 }}>Help me Learn</span>
          </div>
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Moteur d'IA" style={{ position: "relative" }}>
            <AIcon name="spark" size={17} />
            <span style={{ position: "absolute", top: 6, right: 6, width: 8, height: 8, borderRadius: 99, background: provider === "claude" ? "var(--accent)" : provider === "gemini" ? "var(--good)" : "var(--ochre)", border: "1.5px solid var(--surface)" }} />
          </button>
          <button className="icon-btn" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} aria-label="Thème">
            <AIcon name={theme === "dark" ? "sun" : "moon"} size={17} />
          </button>
        </div>
        <main className="content-inner">
          {tab === "learn" && <LearnTab chapters={chapters} current={current} generating={generating} home={home} aiReady={aiReady} onOpenSettings={() => setShowSettings(true)} onGenerate={generateChapter} onRetrySection={retrySection} onSelect={(id) => { setCurrentId(id); setHome(false); }} onDownload={downloadChapter} />}
          {tab === "library" && <LibraryTab chapters={chapters} onOpen={openCourse} onToggleMastered={toggleMastered} onDelete={deleteChapter} onDownload={downloadChapter} onNew={newCourse} />}
          {tab === "quiz" && <QuizTab chapters={chapters} current={current} onSelect={setCurrentId} onRetry={retryQuiz} generating={generating} />}
          {tab === "cards" && <FlashTab chapters={chapters} current={current} onSelect={setCurrentId} onRetry={retryCards} generating={generating} />}
          {tab === "plan" && <PlanTab chapters={chapters} planDays={planDays} />}
        </main>
      </div>

      {/* ---------- API KEY MODAL ---------- */}
      <ApiKeyModal open={showSettings} onClose={closeSettings} />

      {/* ---------- PREFS MODAL ---------- */}
      <PrefsModal open={showPrefs} onClose={closePrefs} />

      {/* ---------- TOAST ---------- */}
      {toast && (
        <div className="fade-in" style={{ position: "fixed", bottom: 26, left: "50%", transform: "translateX(-50%)", zIndex: 100,
          background: "var(--surface)", border: "1px solid var(--line)", boxShadow: "var(--shadow-lg)",
          borderRadius: 12, padding: "12px 18px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 10, maxWidth: "90vw" }}>
          <span style={{ color: "var(--good)" }}><AIcon name="check" size={17} /></span>{toast}
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);