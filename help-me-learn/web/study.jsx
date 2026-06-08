/* ============================================================
   study.jsx — "Quiz" + "Flashcards" tabs
   ============================================================ */
const { Icon: SIcon } = window;

/* ---------- QUIZ ---------- */
function QuizQuestion({ item, index }) {
  const [picked, setPicked] = useState(null);
  const answered = picked !== null;
  return (
    <div className="card" style={{ padding: "20px 22px", marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
        <span style={{ flex: "none", fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 15, color: "var(--accent-deep)" }}>Q{index + 1}</span>
        <h3 style={{ margin: 0, fontSize: 17.5, lineHeight: 1.4 }}>{item.q}</h3>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {item.options.map((opt, i) => {
          const isCorrect = i === item.correct;
          const isPicked = i === picked;
          let bg = "var(--surface)", bd = "var(--line)", col = "var(--ink)", mark = null;
          if (answered) {
            if (isCorrect) { bg = "var(--good-soft)"; bd = "color-mix(in oklch, var(--good) 45%, transparent)"; col = "var(--ink)"; mark = <SIcon name="check" size={17} />; }
            else if (isPicked) { bg = "var(--bad-soft)"; bd = "color-mix(in oklch, var(--bad) 45%, transparent)"; mark = <SIcon name="x" size={17} />; }
            else { col = "var(--ink-faint)"; }
          }
          return (
            <button key={i} onClick={() => !answered && setPicked(i)} disabled={answered}
              style={{ display: "flex", alignItems: "center", gap: 11, textAlign: "left", padding: "11px 14px",
                border: "1.5px solid " + bd, background: bg, color: col, borderRadius: 10, fontSize: 15.5,
                fontFamily: "var(--font-sans)", transition: "all 0.16s ease", cursor: answered ? "default" : "pointer" }}>
              <span style={{ flex: "none", width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center",
                background: answered && (isCorrect || isPicked) ? "transparent" : "var(--surface-2)",
                border: "1px solid var(--line)", fontSize: 13, fontWeight: 600,
                color: answered && isCorrect ? "var(--good)" : answered && isPicked ? "var(--bad)" : "var(--ink-soft)" }}>
                {mark || String.fromCharCode(65 + i)}
              </span>
              <span style={{ flex: 1 }}>{opt}</span>
            </button>
          );
        })}
      </div>
      {answered && (
        <div className="fade-in" style={{ marginTop: 14, padding: "12px 15px", borderRadius: 10,
          background: picked === item.correct ? "var(--good-soft)" : "var(--accent-soft)",
          border: "1px solid " + (picked === item.correct ? "color-mix(in oklch, var(--good) 35%, transparent)" : "var(--accent-line)") }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4, color: picked === item.correct ? "var(--good)" : "var(--accent-deep)" }}>
            {picked === item.correct ? window.ui("quizCorrect") : window.ui("quizWrong") + String.fromCharCode(65 + item.correct) + "."}
          </div>
          <div style={{ fontSize: 14.5, lineHeight: 1.55 }}>{item.explication}</div>
        </div>
      )}
    </div>
  );
}

function QuizTab({ chapters, current, onSelect, onRetry, generating }) {
  if (!current) return <Empty icon="quiz" title={window.ui("quizEmpty")}>{window.ui("quizEmptyDesc")}</Empty>;
  const quiz = current.quiz;
  return (
    <div>
      <PageHead kicker={window.ui("quizKicker")} title={window.ui("quizTitle")}>{window.ui("quizFrom")}{current.titre || "…"}{window.ui("quizFromSuffix")}</PageHead>
      <ChapterSwitch chapters={chapters} current={current} onSelect={onSelect} />
      {current.quizStatus === "loading" && <div className="row soft" style={{ fontSize: 15 }}><Spinner size={16} /> {window.ui("quizLoading")}</div>}
      {current.quizStatus === "error" && (
        <div className="card" style={{ padding: 22, textAlign: "center" }}>
          <p className="soft">{window.ui("quizError")}</p>
          <button className="btn btn-primary" onClick={() => onRetry(current.id)} disabled={generating}><SIcon name="flip" size={15} /> {window.ui("btnRetryQuiz")}</button>
        </div>
      )}
      {quiz && quiz.length > 0 && (
        <div key={current.id}>
          {quiz.map((item, i) => <QuizQuestion key={i} item={item} index={i} />)}
        </div>
      )}
      {(!quiz || quiz.length === 0) && current.quizStatus === "done" && (
        <div className="card" style={{ padding: 22, textAlign: "center" }}>
          <p className="soft" style={{ marginBottom: 14 }}>{window.ui("quizNone")}</p>
          <button className="btn btn-primary" onClick={() => onRetry(current.id)} disabled={generating}><SIcon name="flip" size={15} /> {window.ui("btnGenerateQuiz")}</button>
        </div>
      )}
    </div>
  );
}

/* ---------- FLASHCARDS ---------- */
function Flashcard({ card }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <button onClick={() => setFlipped(f => !f)} aria-label="Retourner la carte"
      style={{ perspective: 1200, background: "none", border: "none", padding: 0, width: "100%", height: 200, cursor: "pointer", textAlign: "left" }}>
      <div style={{ position: "relative", width: "100%", height: "100%", transformStyle: "preserve-3d",
        transition: "transform 0.5s cubic-bezier(.4,.2,.2,1)", transform: flipped ? "rotateY(180deg)" : "none" }}>
        {/* front */}
        <div className="card" style={{ position: "absolute", inset: 0, backfaceVisibility: "hidden", padding: "20px 22px",
          display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent-deep)" }}>{window.ui("cardFront")}</span>
          <div className="prose" style={{ fontSize: 17, fontWeight: 500 }}>{window.renderMarkdown(card.recto)}</div>
          <span className="muted" style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}><SIcon name="flip" size={13} /> {window.ui("cardFlip")}</span>
        </div>
        {/* back */}
        <div className="card" style={{ position: "absolute", inset: 0, backfaceVisibility: "hidden", transform: "rotateY(180deg)",
          padding: "20px 22px", background: "var(--accent-soft)", borderColor: "var(--accent-line)",
          display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "auto" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent-deep)" }}>{window.ui("cardBack")}</span>
          <div className="prose" style={{ fontSize: 15.5 }}>{window.renderMarkdown(card.verso)}</div>
          <span className="muted" style={{ fontSize: 12.5 }}>&nbsp;</span>
        </div>
      </div>
    </button>
  );
}

function FlashTab({ chapters, current, onSelect, onRetry, generating }) {
  if (!current) return <Empty icon="cards" title={window.ui("cardsEmpty")}>{window.ui("cardsEmptyDesc")}</Empty>;
  const cards = current.cards;
  return (
    <div>
      <PageHead kicker={window.ui("cardsKicker")} title={window.ui("cardsTitle")}>{window.ui("cardsFrom")}{current.titre || "…"}{window.ui("cardsFromSuffix")}</PageHead>
      <ChapterSwitch chapters={chapters} current={current} onSelect={onSelect} />
      {current.cardsStatus === "loading" && <div className="row soft" style={{ fontSize: 15 }}><Spinner size={16} /> {window.ui("cardsLoading")}</div>}
      {current.cardsStatus === "error" && (
        <div className="card" style={{ padding: 22, textAlign: "center" }}>
          <p className="soft">{window.ui("cardsError")}</p>
          <button className="btn btn-primary" onClick={() => onRetry(current.id)} disabled={generating}><SIcon name="flip" size={15} /> {window.ui("btnRetry")}</button>
        </div>
      )}
      {cards && cards.length > 0 && (
        <div key={current.id} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
          {cards.map((c, i) => <Flashcard key={i} card={c} />)}
        </div>
      )}
    </div>
  );
}

/* ---------- small chapter switcher reused ---------- */
function ChapterSwitch({ chapters, current, onSelect }) {
  if (!chapters || chapters.length < 2) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
      <span className="muted" style={{ fontSize: 13 }}>{window.ui("chapterSwitchLabel")}</span>
      {chapters.map(ch => (
        <button key={ch.id} className={"btn btn-sm" + (ch.id === current.id ? " btn-primary" : "")} onClick={() => onSelect(ch.id)}>{ch.titre || "…"}</button>
      ))}
    </div>
  );
}

Object.assign(window, { QuizTab, FlashTab, ChapterSwitch });