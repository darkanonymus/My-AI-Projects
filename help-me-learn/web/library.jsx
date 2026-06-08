/* ============================================================
   library.jsx — "Bibliothèque" : persistent archive of every course
   Shows all chapters with progress, mastery, and quick access to
   lesson / quiz / flashcards + per-course download.
   ============================================================ */
const { Icon: BIcon } = window;

function libPct(ch) {
  const total = ch.sections.length;
  const done = ch.sections.filter(s => s.status === "done").length;
  return total ? done / total : 0;
}

function LibStat({ n, label, color }) {
  return (
    <div style={{ minWidth: 70 }}>
      <div style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 27, lineHeight: 1, color: color || "var(--ink)" }}>{n}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 5, fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}>{label}</div>
    </div>
  );
}

function CourseCard({ ch, onOpen, onToggleMastered, onDelete, onDownload }) {
  const [confirm, setConfirm] = useState(false);
  const pct = libPct(ch);
  const done = ch.sections.filter(s => s.status === "done").length;
  return (
    <div className="card course-card-lift" style={{
      padding: 0, overflow: "hidden", display: "flex", flexDirection: "column",
      // mastered courses get a tinted surface + border, not just a thin header strip —
      // breaks the "identical card grid" sameness and makes mastery legible at a glance
      background: ch.mastered ? "color-mix(in oklch, var(--good-soft) 40%, var(--surface))" : "var(--surface)",
      borderColor: ch.mastered ? "color-mix(in oklch, var(--good) 28%, var(--line))" : "var(--line)",
    }}>
      {/* gradient header strip */}
      <div style={{ height: 6, background: ch.mastered ? "linear-gradient(90deg, var(--good), color-mix(in oklch, var(--good) 60%, var(--accent)))" : "var(--grad-accent)" }} />
      <div style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
              {ch.mastered && <Tag variant="good"><BIcon name="check" size={12} /> {window.ui("tagMastered")}</Tag>}
              {ch.langueSource && <Tag variant="mono">{ch.langueSource === "de" ? "DE" : ch.langueSource === "fr" ? "FR" : "DE/FR"}</Tag>}
            </div>
            <h3 style={{ margin: 0, fontSize: 18.5, lineHeight: 1.25 }}>{ch.titre || "Chapitre"}</h3>
            {ch.theme && <p className="soft" style={{ margin: "5px 0 0", fontSize: 13.5, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{ch.theme}</p>}
          </div>
        </div>

        {/* meta chips */}
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <Tag>{done}/{ch.sections.length} sections</Tag>
          {ch.quiz && ch.quiz.length > 0 && <Tag variant="accent"><BIcon name="quiz" size={12} /> {ch.quiz.length} quiz</Tag>}
          {ch.cards && ch.cards.length > 0 && <Tag variant="accent"><BIcon name="cards" size={12} /> {ch.cards.length} cartes</Tag>}
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 6 }}>
            <span className="muted mono">{window.ui("labelProgress")}</span>
            <span className="soft" style={{ fontWeight: 600 }}>{Math.round(pct * 100)}%</span>
          </div>
          <ProgressBar value={pct} />
        </div>

        {/* actions */}
        <div style={{ display: "flex", gap: 8, marginTop: "auto", flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn btn-sm btn-primary" onClick={() => onOpen(ch.id, "learn")}><BIcon name="open" size={14} /> {window.ui("btnOpen")}</button>
          {ch.quiz && ch.quiz.length > 0 && <button className="btn btn-sm" onClick={() => onOpen(ch.id, "quiz")}><BIcon name="quiz" size={14} /></button>}
          {ch.cards && ch.cards.length > 0 && <button className="btn btn-sm" onClick={() => onOpen(ch.id, "cards")}><BIcon name="cards" size={14} /></button>}
          {done > 0 && <button className="btn btn-sm" onClick={() => onDownload(ch.id)} title="Télécharger (HTML / PDF)"><BIcon name="download" size={14} /></button>}
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-ghost" onClick={() => onToggleMastered(ch.id)} title={ch.mastered ? "Retirer « maîtrisé »" : "Marquer comme maîtrisé"}
            style={ch.mastered ? { color: "var(--good)" } : {}}><BIcon name="target" size={14} /></button>
          {!confirm
            ? <button className="btn btn-sm btn-ghost" onClick={() => setConfirm(true)} title="Supprimer"><BIcon name="trash" size={14} /></button>
            : <button className="btn btn-sm" onClick={() => onDelete(ch.id)} style={{ color: "var(--bad)", borderColor: "color-mix(in oklch, var(--bad) 40%, transparent)", background: "var(--bad-soft)" }}>{window.ui("btnConfirm")}</button>}
        </div>
      </div>
    </div>
  );
}

function LibraryTab({ chapters, onOpen, onToggleMastered, onDelete, onDownload, onNew }) {
  if (!chapters.length) {
    return (
      <div>
        <PageHead kicker="Bibliothèque" title="Tous tes cours, au même endroit" />
        <Empty icon="library" title={window.ui("libEmptyTitle")}>
          {window.ui("libEmptyDesc")}
          <div style={{ marginTop: 18 }}>
            <button className="btn btn-primary" onClick={onNew}><BIcon name="plusbig" size={16} /> {window.ui("btnFirstCourse")}</button>
          </div>
        </Empty>
      </div>
    );
  }
  const overall = chapters.reduce((a, c) => a + libPct(c), 0) / chapters.length;
  const mastered = chapters.filter(c => c.mastered).length;
  const totalCards = chapters.reduce((a, c) => a + (c.cards ? c.cards.length : 0), 0);
  const totalQuiz = chapters.reduce((a, c) => a + (c.quiz ? c.quiz.length : 0), 0);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <PageHead kicker={window.ui("libKicker")} title={chapters.length + " " + (chapters.length > 1 ? window.ui("libTitleN") : window.ui("libTitle1"))}>
          {window.ui("libDesc")}
        </PageHead>
        <button className="btn btn-primary" onClick={onNew} style={{ flex: "none" }}><BIcon name="plusbig" size={16} /> {window.ui("btnNewCourse")}</button>
      </div>

      {/* stats banner */}
      <div className="card" style={{ padding: "20px 24px", marginBottom: 24, display: "flex", gap: 26, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 76, height: 76, flex: "none" }}>
          <Ring value={overall} size={76} stroke={7} />
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 19 }}>{Math.round(overall * 100)}%</div>
        </div>
        <div style={{ display: "flex", gap: 30, flexWrap: "wrap", flex: 1 }}>
          <LibStat n={chapters.length} label={window.ui("statCours")} />
          <LibStat n={mastered} label={window.ui("statMaitrises")} color="var(--good)" />
          <LibStat n={totalQuiz} label={window.ui("statQuestions")} />
          <LibStat n={totalCards} label={window.ui("statCards")} />
        </div>
      </div>

      {/* course grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 18 }}>
        {chapters.slice().reverse().map(ch => (
          <CourseCard key={ch.id} ch={ch} onOpen={onOpen} onToggleMastered={onToggleMastered} onDelete={onDelete} onDownload={onDownload} />
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { LibraryTab });