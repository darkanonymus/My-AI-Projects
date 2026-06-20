/* ============================================================
   progress.jsx — "Progression" tab: a dashboard that tracks your
   evolution over time (quiz scores, courses mastered, activity)
   from the progressLog (recorded going forward) + course metadata.
   ============================================================ */
const { Icon: PIcon, PageHead, Empty, ProgressBar } = window;

const _DAY = 86400000;
function _dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function _fmtDate(t) { try { return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch (e) { return ""; } }
function _tone(pct) { return pct >= 80 ? "var(--good)" : pct >= 50 ? "var(--accent)" : "var(--bad)"; }

/* current streak: consecutive calendar days with activity, ending today or yesterday */
function _streak(days) {
  if (!days.size) return 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let cur = today.getTime();
  if (!days.has(_dayKey(cur))) { cur -= _DAY; if (!days.has(_dayKey(cur))) return 0; }
  let n = 0;
  while (days.has(_dayKey(cur))) { n++; cur -= _DAY; }
  return n;
}

function ProgStat({ n, label, color, sub }) {
  return (
    <div style={{ flex: "1 1 120px" }}>
      <div className="stat-n" style={color ? { color } : undefined}>{n}</div>
      <div className="stat-label mono" style={{ letterSpacing: "0.02em" }}>{label}</div>
      {sub && <div className="muted" style={{ fontSize: "var(--fs-micro)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/* recent quiz attempts as height-proportional bars (CSS, theme-aware) */
function QuizBars({ events }) {
  const data = events.slice(-30);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: data.length > 18 ? 3 : 6, height: 130 }}>
      {data.map((e, i) => {
        const pct = e.total ? Math.round(e.score / e.total * 100) : 0;
        return (
          <div key={i} title={_fmtDate(e.t) + " · " + e.score + "/" + e.total + " (" + pct + "%)"}
            style={{ flex: 1, minWidth: 4, height: Math.max(3, pct) + "%", background: _tone(pct),
              borderRadius: "4px 4px 0 0", transition: "height .3s var(--ease-out)" }} />
        );
      })}
    </div>
  );
}

/* cumulative count of courses created, as a stepped area */
function CreatedTimeline({ chapters }) {
  const pts = chapters.map(c => c.createdAt || 0).filter(Boolean).sort((a, b) => a - b);
  if (pts.length < 2) return <div className="muted" style={{ fontSize: "var(--fs-small)" }}>Frise disponible dès 2 cours.</div>;
  const t0 = pts[0], t1 = pts[pts.length - 1], span = (t1 - t0) || 1;
  const W = 100, H = 36;
  let d = "M 0 " + H;
  pts.forEach((t, i) => { const x = (t - t0) / span * W; const y = H - ((i + 1) / pts.length) * H; d += " L " + x.toFixed(1) + " " + H.toFixed(1) + " L " + x.toFixed(1) + " " + y.toFixed(1); });
  d += " L " + W + " " + (H - H).toFixed(1) + " L " + W + " " + H + " Z";
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 60, display: "block" }}>
        <path d={d} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="0.8" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span className="muted mono" style={{ fontSize: "var(--fs-micro)" }}>{_fmtDate(t0)}</span>
        <span className="muted mono" style={{ fontSize: "var(--fs-micro)" }}>{_fmtDate(t1)}</span>
      </div>
    </div>
  );
}

function ProgressDashboard({ chapters, progressLog, onOpen }) {
  const log = Array.isArray(progressLog) ? progressLog : [];
  const quizEvents = log.filter(e => e.type === "quiz" && e.total).sort((a, b) => a.t - b.t);
  const days = new Set(log.map(e => _dayKey(e.t)));
  const mastered = chapters.filter(c => c.mastered).length;
  const avgPct = quizEvents.length
    ? Math.round(quizEvents.reduce((a, e) => a + e.score / e.total * 100, 0) / quizEvents.length)
    : null;
  const streak = _streak(days);

  // latest quiz pct per course
  const lastQuiz = {};
  quizEvents.forEach(e => { lastQuiz[e.courseId] = Math.round(e.score / e.total * 100); });

  if (!chapters.length) {
    return (
      <div>
        <PageHead kicker="Progression" title="Suis ton évolution" />
        <Empty icon="progress" title="Pas encore de cours">Crée un cours, révise son quiz : ta progression s'affichera ici.</Empty>
      </div>
    );
  }

  return (
    <div>
      <PageHead kicker={window.ui("tabProgress") || "Progression"} title="Suis ton évolution">
        Tes scores de quiz, tes cours maîtrisés et ton activité — l'historique se construit au fil de tes révisions.
      </PageHead>

      {/* snapshot */}
      <div className="card" style={{ padding: "var(--space-5) var(--space-6)", marginBottom: "var(--space-6)", display: "flex", gap: "var(--space-6)", flexWrap: "wrap" }}>
        <ProgStat n={chapters.length} label="Cours" />
        <ProgStat n={mastered} label="Maîtrisés" color="var(--good)" />
        <ProgStat n={avgPct == null ? "—" : avgPct + "%"} label="Score quiz moyen" sub={quizEvents.length ? quizEvents.length + " quiz" : "aucun quiz"} />
        <ProgStat n={streak} label="Série (jours)" color={streak > 0 ? "var(--accent-deep)" : undefined} sub={days.size + " jour(s) actif(s)"} />
      </div>

      {/* quiz scores over time */}
      <div className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-5)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "var(--space-4)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--fs-h4)" }}>Scores de quiz dans le temps</h3>
          {quizEvents.length > 0 && <span className="muted mono" style={{ fontSize: "var(--fs-micro)" }}>{Math.min(30, quizEvents.length)} dernier(s)</span>}
        </div>
        {quizEvents.length > 0
          ? <QuizBars events={quizEvents} />
          : <p className="soft" style={{ fontSize: "var(--fs-small)", margin: 0 }}>Termine un quiz (onglet Quiz) pour voir ta courbe apparaître — l'évolution démarre maintenant.</p>}
      </div>

      {/* courses created timeline */}
      <div className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-5)" }}>
        <h3 style={{ margin: "0 0 var(--space-4)", fontSize: "var(--fs-h4)" }}>Cours ajoutés dans le temps</h3>
        <CreatedTimeline chapters={chapters} />
      </div>

      {/* per-course breakdown */}
      <div className="card" style={{ padding: "var(--space-5)" }}>
        <h3 style={{ margin: "0 0 var(--space-4)", fontSize: "var(--fs-h4)" }}>Par cours</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {chapters.slice().reverse().map(ch => {
            const secs = ch.sections || [];
            const done = secs.filter(s => s.status === "done").length;
            const pct = secs.length ? Math.round(done / secs.length * 100) : 0;
            const q = lastQuiz[ch.id];
            return (
              <button key={ch.id} onClick={() => onOpen && onOpen(ch.id, "learn")}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", width: "100%", textAlign: "left",
                  background: "none", border: "none", borderBottom: "1px solid var(--line)", padding: "var(--space-2) 0", cursor: "pointer" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ch.titre || "Sans titre"}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span style={{ flex: "0 0 110px", maxWidth: 110 }}><ProgressBar value={done} max={secs.length || 1} /></span>
                    <span className="muted mono" style={{ fontSize: "var(--fs-micro)" }}>{pct}%</span>
                  </span>
                </span>
                {q != null && <span className="mono" style={{ flex: "none", fontSize: "var(--fs-small)", color: _tone(q) }} title="Dernier score de quiz">quiz {q}%</span>}
                {ch.mastered
                  ? <span className="tag" style={{ flex: "none", color: "var(--good)", borderColor: "color-mix(in oklch, var(--good) 35%, transparent)", background: "var(--good-soft)" }}><PIcon name="check" size={12} /> maîtrisé</span>
                  : <PIcon name="chevrondown" size={15} style={{ flex: "none", transform: "rotate(-90deg)", opacity: 0.4 }} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ProgressDashboard });
