/* ============================================================
   planning.jsx — "Progression" + "Plan 40 jours" tabs
   ============================================================ */
const { Icon: PIcon } = window;

/* ---------- PROGRESSION ---------- */
function chapterPct(ch) {
  const total = ch.sections.length;
  const done = ch.sections.filter(s => s.status === "done").length;
  return total ? done / total : 0;
}

function ProgressTab({ chapters, onSelect, onToggleMastered, onDelete }) {
  if (!chapters.length) {
    return <Empty icon="progress" title="Ta progression apparaîtra ici">Chaque chapitre que tu étudies est suivi : sections complétées, quiz, flashcards, et statut « maîtrisé ».</Empty>;
  }
  const overall = chapters.reduce((a, c) => a + chapterPct(c), 0) / chapters.length;
  const mastered = chapters.filter(c => c.mastered).length;
  return (
    <div>
      <PageHead kicker="Progression" title="Où tu en es" />
      <div className="card" style={{ padding: 22, marginBottom: 22, display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 78, height: 78, flex: "none" }}>
          <Ring value={overall} size={78} stroke={7} />
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 20 }}>{Math.round(overall * 100)}%</div>
        </div>
        <div style={{ display: "flex", gap: 30, flexWrap: "wrap" }}>
          <Stat n={chapters.length} label="Chapitres" />
          <Stat n={mastered} label="Maîtrisés" />
          <Stat n={chapters.reduce((a, c) => a + (c.cards ? c.cards.length : 0), 0)} label="Flashcards" />
          <Stat n={chapters.reduce((a, c) => a + (c.quiz ? c.quiz.length : 0), 0)} label="Questions quiz" />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {chapters.map(ch => {
          const pct = chapterPct(ch);
          return (
            <div key={ch.id} className="card" style={{ padding: "16px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 3 }}>
                    <h3 style={{ margin: 0, fontSize: 17 }}>{ch.titre || "Chapitre"}</h3>
                    {ch.mastered && <Tag variant="good"><PIcon name="check" size={12} /> Maîtrisé</Tag>}
                  </div>
                  {ch.theme && <p className="soft" style={{ margin: 0, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.theme}</p>}
                </div>
                <div style={{ width: 150, flex: "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                    <span className="muted">Sections</span>
                    <span className="soft" style={{ fontWeight: 600 }}>{ch.sections.filter(s => s.status === "done").length}/{ch.sections.length}</span>
                  </div>
                  <ProgressBar value={pct} />
                </div>
                <div style={{ display: "flex", gap: 7, flex: "none" }}>
                  <button className="btn btn-sm" onClick={() => onSelect(ch.id)}>Ouvrir</button>
                  <button className="btn btn-sm" onClick={() => onToggleMastered(ch.id)} title="Marquer comme maîtrisé"
                    style={ch.mastered ? { background: "var(--good-soft)", borderColor: "color-mix(in oklch, var(--good) 35%, transparent)", color: "var(--good)" } : {}}>
                    <PIcon name="target" size={14} />
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => onDelete(ch.id)} title="Supprimer"><PIcon name="trash" size={14} /></button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ n, label }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 26, lineHeight: 1 }}>{n}</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{label}</div>
    </div>
  );
}

/* ---------- N-DAY PLAN ---------- */
function PlanTab({ chapters, planDays }) {
  const totalDays = planDays || 40;
  const phases = window.buildPlanPhases(totalDays);
  const days = window.buildPlan(chapters, totalDays);
  const colorVar = (c) => c === "ochre" ? "var(--ochre)" : c === "good" ? "var(--good)" : "var(--accent)";
  const taskStyle = (type) => {
    if (type === "new")    return { bg: "var(--accent-soft)", bd: "var(--accent-line)", col: "var(--accent-deep)", icon: "spark", label: window.ui("planTaskStudy") };
    if (type === "review") return { bg: "var(--surface-2)", bd: "var(--line)", col: "var(--ink-soft)", icon: "flip", label: window.ui("planTaskReview") };
    return { bg: "var(--good-soft)", bd: "color-mix(in oklch, var(--good) 35%, transparent)", col: "var(--good)", icon: "target", label: "" };
  };
  return (
    <div>
      <PageHead kicker={window.ui("planKicker")} title={window.ui("planDaysTitle").replace("{n}", totalDays)}>
        {chapters.length ? window.ui("planAdapted").replace("{n}", chapters.length).replace("{s}", chapters.length>1?"s":"") : window.ui("planEmptyDesc")}
      </PageHead>

      {/* phases legend */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 12, marginBottom: 24 }}>
        {phases.map((p, i) => (
          <div key={i} className="card" style={{ padding: "14px 16px", borderLeft: "4px solid " + colorVar(p.couleur) }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-faint)" }}>Jours {p.jours[0]}–{p.jours[1]}</div>
            <h3 style={{ margin: "3px 0 5px", fontSize: 16 }}>{p.nom}</h3>
            <p className="soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{p.desc}</p>
          </div>
        ))}
      </div>

      {/* day grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
        {days.map(d => {
          const accent = colorVar(d.phase.couleur);
          return (
            <div key={d.jour} className="card" style={{ padding: "11px 12px", minHeight: 96, display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 15 }}>Jour {d.jour}</span>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: accent }} />
              </div>
              {d.taches.length === 0 && <span className="muted" style={{ fontSize: 12 }}>{window.ui("planFree")}</span>}
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {d.taches.slice(0, 4).map((t, i) => {
                  const st = taskStyle(t.type);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "4px 7px", borderRadius: 7,
                      background: st.bg, border: "1px solid " + st.bd, color: st.col, lineHeight: 1.25 }}>
                      <span style={{ flex: "none" }}><PIcon name={st.icon} size={11} /></span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{st.label ? st.label + " : " : ""}{t.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 22, padding: "16px 18px", display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: "var(--accent-soft)", border: "1px solid var(--accent-line)" }} /> {window.ui("planLegendStudy")}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: "var(--surface-2)", border: "1px solid var(--line)" }} /> {window.ui("planLegendReview")}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: "var(--good-soft)", border: "1px solid color-mix(in oklch, var(--good) 35%, transparent)" }} /> {window.ui("planLegendExam")}</span>
      </div>
    </div>
  );
}

Object.assign(window, { ProgressTab, PlanTab });