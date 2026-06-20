/* ============================================================
   learn.jsx — "Apprendre" tab : input, import, lesson view
   ============================================================ */
const { Icon: LIcon } = window;

/* ---------- Composer : paste text or import PDF/image ---------- */
function Composer({ onGenerate, generating, compact, aiReady, onOpenSettings }) {
  const [text, setText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [status, setStatus] = useState("");
  const [warn, setWarn] = useState("");
  const [fileName, setFileName] = useState("");
  const [imgs, setImgs] = useState([]);
  const fileRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setWarn(""); setStatus(""); setFileName(file.name); setImgs([]);
    const isPDF = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isImg = /^image\//.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
    if (!isPDF && !isImg) { setWarn("Format non géré. Utilise un PDF, un PNG ou un JPG, ou colle le texte directement."); return; }
    if (file.size > 9 * 1024 * 1024) {
      setWarn("Ce fichier est volumineux (" + (file.size/1048576).toFixed(1) + " Mo). Le traitement peut échouer ou être lent — mieux vaut le découper par chapitre et l'envoyer en plusieurs fois.");
    }
    setExtracting(true);
    try {
      let res;
      if (isPDF) res = await window.extractFromPDF(file, setStatus);
      else res = await window.extractFromImage(file, setStatus);
      const extracted = (res.text || "").trim();
      if (!extracted || extracted.length < 12) {
        setWarn("Aucun texte exploitable n'a pu être extrait" + (isImg ? " (image peu lisible pour l'OCR)" : " (PDF peut-être scanné, sans texte)") + ". Essaie une autre source ou colle le texte à la main.");
      } else {
        let note = "";
        if (isPDF && res.truncated) note = "\n\n[Note : seules les 30 premières pages sur " + res.pages + " ont été lues. Découpe le reste par chapitre.]";
        if (isImg) note = "\n\n[Texte obtenu par OCR — à vérifier, des erreurs de reconnaissance sont possibles.]";
        setText((extracted + note).trim());
        const figs = (isPDF && Array.isArray(res.images)) ? res.images : [];
        setImgs(figs);
        const figNote = figs.length ? " · " + figs.length + " figure" + (figs.length > 1 ? "s" : "") + " du cours conservée" + (figs.length > 1 ? "s" : "") : "";
        setStatus((isImg ? "OCR terminé — vérifie le texte ci-dessous avant de générer." : "PDF lu (" + res.pages + " page" + (res.pages>1?"s":"") + ") — vérifie le texte ci-dessous.") + figNote);
      }
    } catch (err) {
      setWarn("Échec de la lecture du fichier : " + (err.message || err) + ". Tu peux coller le texte à la main.");
      setStatus("");
    } finally {
      setExtracting(false);
    }
  }

  function submit() {
    const t = text.trim();
    if (t.length < 8 || generating || extracting) return;
    onGenerate(t, fileName, imgs);
    setText(""); setFileName(""); setStatus(""); setWarn(""); setImgs([]);
  }

  const busy = generating || extracting;
  return (
    <div className="card" style={{ padding: compact ? "var(--space-4)" : "var(--space-5)", marginBottom: compact ? "var(--space-5)" : 0 }}>
      {!aiReady && (
        <div className="notice notice--accent" style={{ marginBottom: "var(--space-4)" }}>
          <span style={{ flex: 1 }}>Choisis un moteur d'IA pour activer la génération.</span>
          <button className="btn btn-sm btn-primary" onClick={onOpenSettings}><LIcon name="spark" size={13} /> Choisir le moteur</button>
        </div>
      )}
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <Tag variant="accent"><LIcon name="spark" size={13} /> Nouveau chapitre</Tag>
          <span className="muted" style={{ fontSize: "var(--fs-small)" }}>{window.ui("btnImport").replace("Importer ","")} PDF / image</span>
        </div>
      )}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={window.ui("composerPlaceholder")}
        rows={compact ? 3 : 6}
        disabled={busy}
        className="field"
        style={{ resize: "vertical", minHeight: compact ? 70 : 130 }}
      />
      {fileName && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", marginTop: "var(--space-2)", fontSize: "var(--fs-small)", color: "var(--ink-soft)" }}>
          <LIcon name={/\.pdf$/i.test(fileName) ? "file" : "image"} size={15} />
          <span className="mono">{fileName}</span>
        </div>
      )}
      {status && <div style={{ marginTop: "var(--space-3)", fontSize: "var(--fs-small)", color: "var(--accent-deep)", display: "flex", gap: "var(--space-2)", alignItems: "center" }}>{extracting && <Spinner size={14} />}{status}</div>}
      {warn && (
        <div className="notice notice--ochre" style={{ marginTop: "var(--space-3)" }}>
          <span style={{ flex: "none", marginTop: 1 }}><LIcon name="warn" size={15} /></span><span>{warn}</span>
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)", flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !aiReady || text.trim().length < 8}>
          {generating ? <><Spinner size={15} /> {window.ui("btnGenerating")}</> : <><LIcon name="spark" size={16} /> {window.ui("btnGenerate")}</>}
        </button>
        <button className="btn" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
          <LIcon name="upload" size={16} /> {window.ui("btnImport")}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,image/png,image/jpeg,image/webp" onChange={handleFile} style={{ display: "none" }} />
      </div>
    </div>
  );
}

/* ---------- Glossary strip (DE → FR) ---------- */
function Glossary({ termes }) {
  if (!termes || !termes.length) return null;
  return (
    <div className="card" style={{ padding: "var(--space-4) var(--space-5)", marginBottom: "var(--space-6)" }}>
      <div className="field-label" style={{ marginBottom: "var(--space-3)" }}>
        {window.ui("glossaryTitle")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-3)" }}>
        {termes.map((t, i) => (
          <div key={i} style={{ background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: "var(--radius-sm)", padding: "var(--space-2) var(--space-3)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-1)", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: "var(--fs-small)", color: "var(--accent-deep)" }}>{t.de}</span>
              <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-soft)" }}>→ {t.fr}</span>
            </div>
            {t.def && <div className="soft" style={{ fontSize: "var(--fs-small)", marginTop: 2, lineHeight: 1.5 }}>{t.def}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- A user-requested Q&A / example / bank-add card, anchored to one course block ---------- */
function InsertionCard({ insertion, onAddToBank, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const ins = insertion;
  const linkedToBank = !!ins.addedToCards || !!ins.addedToQuiz;
  const kindLabel = ins.kind === "ask" ? <><LIcon name="message" size={12} /> Votre question</>
    : ins.kind === "example" ? <><LIcon name="idea" size={12} /> Exemple demandé</>
    : <><LIcon name="cards" size={12} /> Ajout au quiz / cartes</>;
  const dangerBtn = { color: "var(--bad)", borderColor: "color-mix(in oklch, var(--bad) 40%, transparent)", background: "var(--bad-soft)" };
  const quote = ins.anchorQuote.length > 200 ? ins.anchorQuote.slice(0, 200) + "…" : ins.anchorQuote;
  return (
    <div className="insertion-card fade-in">
      <div className="insertion-card-label">{kindLabel}</div>
      <div className="anchor-quote">« {quote} »</div>
      {ins.kind === "ask" && ins.question && <p style={{ fontWeight: 600, marginBottom: 6 }}>{ins.question}</p>}
      {ins.answer && <div className="prose">{window.renderMarkdown(ins.answer)}</div>}
      {ins.sourceLabel && (
        <div style={{ marginTop: 8 }}>
          <Tag variant={ins.sourceLabel === "cours" ? "good" : "ochre"}>
            {ins.sourceLabel === "cours" ? <><LIcon name="book" size={11} /> D'après le cours</> : "Hors cours — explication complémentaire"}
          </Tag>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        {!linkedToBank && (
          <button className="btn btn-sm" onClick={() => onAddToBank(ins.id, ins.anchorQuote)}>
            <LIcon name="cards" size={13} /> Ajouter au quiz/cartes
          </button>
        )}
        {linkedToBank && (
          <Tag variant="good">
            <LIcon name="check" size={11} /> {ins.addedToCards && ins.addedToQuiz ? "Ajouté au quiz et aux cartes" : ins.addedToCards ? "Ajouté aux cartes" : "Ajouté au quiz"}
          </Tag>
        )}
        <span style={{ flex: 1 }} />
        {!confirming && (
          <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(true)} title="Supprimer"><LIcon name="trash" size={13} /></button>
        )}
        {confirming && !linkedToBank && (
          <button className="btn btn-sm" onClick={() => onDelete(ins.id, false)} style={dangerBtn}>{window.ui("btnConfirm")}</button>
        )}
        {confirming && linkedToBank && (
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="soft" style={{ fontSize: 12.5 }}>Supprimer aussi la carte/question associée ?</span>
            <button className="btn btn-sm" onClick={() => onDelete(ins.id, false)}>Garder</button>
            <button className="btn btn-sm" onClick={() => onDelete(ins.id, true)} style={dangerBtn}>Supprimer tout</button>
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- Collapsed placeholder for a hidden passage (chapter.hiddenBlocks[]) ---------- */
function CollapsedPassage({ hidden, onRestore, children }) {
  const [revealed, setRevealed] = useState(false);
  const count = hidden.toBlock - hidden.fromBlock + 1;
  const label = count <= 1 ? "1 passage masqué" : count + " passages masqués";
  return (
    <div className="hidden-passage fade-in" data-block-index={hidden.fromBlock}>
      <div className="hidden-passage-bar">
        <span className="soft" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
          <LIcon name="hide" size={15} /> {label}
        </span>
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-sm btn-ghost" onClick={() => setRevealed(r => !r)}>
            <LIcon name={revealed ? "hide" : "eye"} size={13} /> {revealed ? "Masquer à nouveau" : "Afficher"}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => onRestore(hidden.id)}>
            <LIcon name="flip" size={13} /> Restaurer
          </button>
        </span>
      </div>
      <div className="hidden-passage-content" data-open={revealed}>
        <div className="hidden-passage-content-inner">{children}</div>
      </div>
    </div>
  );
}

/* ---------- One lesson section card ---------- */
function SectionCard({ section, chapter, onRetry, onAddToBank, onDeleteInsertion, onRestoreHiddenBlock }) {
  const { n, titre, court, status, contenu, err } = section;
  const insertions = (chapter.insertions || []).filter(ins => ins.sectionN === n);
  const hiddenRanges = (chapter.hiddenBlocks || []).filter(h => h.sectionN === n);
  function injectAfter(blockIdx) {
    const matches = insertions.filter(ins => ins.afterBlock === blockIdx);
    if (!matches.length) return null;
    return (
      <React.Fragment key={"ins-after-" + blockIdx}>
        {matches.map(ins => (
          <InsertionCard key={ins.id} insertion={ins} onAddToBank={onAddToBank} onDelete={onDeleteInsertion} />
        ))}
      </React.Fragment>
    );
  }
  return (
    <section className="card section-card fade-in" data-status={status} data-section-n={n} style={{ padding: "20px 22px 20px 25px", marginBottom: 14 }} data-screen-label={"Section " + n}>
      <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: status === "done" ? 14 : 4 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9, flex: "none", display: "grid", placeItems: "center",
          fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 16,
          background: status === "done" ? "var(--accent)" : "var(--surface-2)",
          color: status === "done" ? "var(--paper)" : "var(--ink-faint)",
          border: status === "done" ? "none" : "1px solid var(--line)",
        }}>{n}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 18.5 }}>{titre}</h3>
        </div>
        {status === "loading" && <span style={{ color: "var(--accent)" }}><Spinner size={16} /></span>}
        {status === "pending" && <Tag>{window.ui("sectionPending")}</Tag>}
        {status === "error" && <button className="btn btn-sm" onClick={onRetry}><LIcon name="flip" size={13} /> {window.ui("btnRetry")}</button>}
      </div>
      {status === "loading" && !contenu && <ShimmerLines />}
      {status === "loading" && contenu && <div className="prose">{window.renderMarkdown(contenu, null, null, null, chapter.id)}</div>}
      {status === "error" && (
        <div style={{ fontSize: 14 }}>
          <div className="soft" style={{ marginBottom: err ? 8 : 0 }}>{window.ui("sectionError")}</div>
          {err && (
            <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--bad)", background: "var(--bad-soft)", border: "1px solid color-mix(in oklch, var(--bad) 35%, transparent)", borderRadius: 9, padding: "9px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {err}
            </div>
          )}
        </div>
      )}
      {status === "done" && <div className="prose">{window.renderMarkdown(contenu, injectAfter, hiddenRanges, onRestoreHiddenBlock, chapter.id)}</div>}
    </section>
  );
}

function ShimmerLines() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "6px 0" }}>
      {[92, 100, 78].map((w, i) => (
        <div key={i} style={{ height: 11, width: w + "%", borderRadius: 6, background: "linear-gradient(90deg, var(--surface-2), var(--line), var(--surface-2))", backgroundSize: "200% 100%", animation: "shimmer 1.3s ease infinite" }} />
      ))}
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
    </div>
  );
}

/* ---------- Callout (à vérifier / prochaine étape) ---------- */
function Callout({ variant, icon, title, children }) {
  const soft = variant === "ochre" ? "var(--ochre-soft)" : variant === "good" ? "var(--good-soft)" : "var(--accent-soft)";
  const line = variant === "ochre" ? "var(--ochre-line)" : variant === "good" ? "color-mix(in oklch, var(--good) 35%, transparent)" : "var(--accent-line)";
  const deep = variant === "ochre" ? "var(--ochre-deep)" : variant === "good" ? "var(--good)" : "var(--accent-deep)";
  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 14, background: soft, borderColor: line }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8, color: deep, fontWeight: 600, fontSize: 15 }}>
        <LIcon name={icon} size={18} /> {title}
      </div>
      <div className="prose" style={{ fontSize: 15.5 }}>{children}</div>
    </div>
  );
}

/* ---------- Floating selection menu: ask / example / add-to-bank on a course passage ---------- */
function SelectionAssistant({ chapter, onAddInsertion, onAddHiddenBlock, onCheckBank }) {
  const [sel, setSel] = useState(null);     // { text, sectionN, afterBlock, fromBlock, toBlock, rect }
  const [panel, setPanel] = useState(null); // { kind, phase, question?, answer?, sourceLabel?, error? }
  const wrapRef = useRef(null);
  const rangeRef = useRef(null); // live Range clone — lets the panel track the passage as the page scrolls

  function dismiss() { setSel(null); setPanel(null); rangeRef.current = null; }

  useEffect(() => {
    function handleUp(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      const s = window.getSelection();
      const text = s ? s.toString().trim() : "";
      if (!text || text.length < 2 || !s.rangeCount) { dismiss(); return; }
      const range = s.getRangeAt(0);
      let node = range.startContainer;
      if (node.nodeType === 3) node = node.parentElement;
      let endNode = range.endContainer;
      if (endNode.nodeType === 3) endNode = endNode.parentElement;
      const blockEl = node && node.closest ? node.closest("[data-block-index]") : null;
      const endBlockEl = endNode && endNode.closest ? endNode.closest("[data-block-index]") : null;
      const sectionEl = node && node.closest ? node.closest("[data-section-n]") : null;
      const proseEl = node && node.closest ? node.closest(".prose") : null;
      if (!blockEl || !endBlockEl || !sectionEl || !proseEl) { dismiss(); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const a = +blockEl.getAttribute("data-block-index");
      const b = +endBlockEl.getAttribute("data-block-index");
      rangeRef.current = range.cloneRange();
      setSel({
        text,
        sectionN: +sectionEl.getAttribute("data-section-n"),
        afterBlock: Math.min(a, b),
        fromBlock: Math.min(a, b),
        toBlock: Math.max(a, b),
        rect: { top: rect.top, left: rect.left, width: rect.width },
      });
      setPanel(null);
    }
    document.addEventListener("mouseup", handleUp);
    return () => document.removeEventListener("mouseup", handleUp);
  }, []);

  // Re-anchor the floating panel to the selected passage as the page scrolls
  // (instead of leaving it floating in place over newly-revealed content),
  // and dismiss it once that passage scrolls out of view entirely.
  useEffect(() => {
    let raf = null;
    function track() {
      raf = null;
      const range = rangeRef.current;
      if (!range) return;
      const rect = range.getBoundingClientRect();
      const offscreen = !rect || (rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > window.innerHeight;
      if (offscreen) { dismiss(); return; }
      setSel(prev => prev ? { ...prev, rect: { top: rect.top, left: rect.left, width: rect.width } } : prev);
    }
    function onScrollOrResize() { if (raf == null) raf = requestAnimationFrame(track); }
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, []);

  if (!sel) return null;
  const section = chapter.sections.find(s => s.n === sel.sectionN);
  if (!section) return null;

  const top = Math.max(8, sel.rect.top - 46);
  const left = Math.max(8, Math.min(window.innerWidth - 280, sel.rect.left + sel.rect.width / 2 - 90));
  const quote = sel.text.length > 140 ? sel.text.slice(0, 140) + "…" : sel.text;
  const close = dismiss;
  const dangerBtn = { color: "var(--bad)", borderColor: "color-mix(in oklch, var(--bad) 40%, transparent)", background: "var(--bad-soft)" };
  const passageCount = sel.toBlock - sel.fromBlock + 1;

  async function runAsk(question) {
    setPanel({ kind: "ask", phase: "loading", question });
    try {
      const data = window.parseJSON(await window.callClaude(window.buildAskPrompt(chapter, section, sel.text, question)));
      if (!data || !data.reponse || data.reponse.length < 2) { setPanel({ kind: "ask", phase: "error", question, error: "Réponse vide du moteur." }); return; }
      setPanel({ kind: "ask", phase: "result", question, answer: data.reponse, sourceLabel: data.trouveDansLeCours ? "cours" : "hors-cours" });
    } catch (e) { setPanel({ kind: "ask", phase: "error", question, error: (e && e.message) || String(e) }); }
  }

  async function runExample() {
    setPanel({ kind: "example", phase: "loading" });
    try {
      const data = window.parseJSON(await window.callClaude(window.buildExamplePrompt(chapter, section, sel.text)));
      if (!data || !data.reponse || data.reponse.length < 2) { setPanel({ kind: "example", phase: "error", error: "Réponse vide du moteur." }); return; }
      setPanel({ kind: "example", phase: "result", answer: data.reponse, sourceLabel: data.trouveDansLeCours ? "cours" : "hors-cours" });
    } catch (e) { setPanel({ kind: "example", phase: "error", error: (e && e.message) || String(e) }); }
  }

  async function runBank() {
    setPanel({ kind: "bank", phase: "loading" });
    await onCheckBank(sel.text);
    close();
  }

  function askHide() { setPanel({ kind: "hide", phase: "confirm" }); }
  function confirmHide() {
    onAddHiddenBlock({ sectionN: sel.sectionN, fromBlock: sel.fromBlock, toBlock: sel.toBlock });
    close();
  }

  function insert() {
    onAddInsertion({
      sectionN: sel.sectionN, afterBlock: sel.afterBlock, anchorQuote: sel.text,
      kind: panel.kind, question: panel.question || "", answer: panel.answer, sourceLabel: panel.sourceLabel,
    });
    close();
  }

  return (
    <div ref={wrapRef} style={{ position: "fixed", top, left, zIndex: 60 }}>
      {!panel && (
        <div className="selection-toolbar">
          <button className="btn btn-sm" onClick={() => setPanel({ kind: "ask", phase: "input", question: "" })}><LIcon name="message" size={13} /> Poser une question</button>
          <button className="btn btn-sm" onClick={runExample}><LIcon name="idea" size={13} /> Exemple plus simple</button>
          <button className="btn btn-sm" onClick={runBank}><LIcon name="cards" size={13} /> Ajouter au quiz/cartes</button>
          <button className="btn btn-sm" onClick={askHide}><LIcon name="hide" size={13} /> Masquer ce passage</button>
          <button className="btn btn-sm btn-ghost" onClick={close} title="Fermer"><LIcon name="x" size={13} /></button>
        </div>
      )}
      {panel && panel.kind === "hide" && panel.phase === "confirm" && (
        <div className="selection-panel">
          <div style={{ fontSize: 14.5, marginBottom: 12 }}>
            Masquer {passageCount === 1 ? "ce paragraphe" : "ces " + passageCount + " paragraphes"} du cours ?
            <div className="soft" style={{ fontSize: 12.5, marginTop: 4 }}>Le texte original est conservé — vous pourrez l'afficher ou le restaurer à tout moment.</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm" style={dangerBtn} onClick={confirmHide}><LIcon name="hide" size={13} /> {window.ui("btnConfirm")}</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setPanel(null)}>Annuler</button>
          </div>
        </div>
      )}
      {panel && panel.kind === "ask" && panel.phase === "input" && (
        <div className="selection-panel">
          <div className="soft" style={{ fontSize: 13, marginBottom: 8 }}>« {quote} »</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input autoFocus className="selection-input" placeholder="Ta question sur ce passage…" value={panel.question}
              onChange={e => setPanel({ ...panel, question: e.target.value })}
              onKeyDown={e => { if (e.key === "Enter" && panel.question.trim().length > 2) runAsk(panel.question.trim()); }} />
            <button className="btn btn-sm btn-primary" disabled={panel.question.trim().length < 3} onClick={() => runAsk(panel.question.trim())}>Demander</button>
          </div>
        </div>
      )}
      {panel && panel.phase === "loading" && (
        <div className="selection-panel" style={{ display: "flex", alignItems: "center", gap: 9 }}><Spinner size={15} /> Lia réfléchit…</div>
      )}
      {panel && panel.phase === "error" && (
        <div className="selection-panel">
          <div className="mono" style={{ fontSize: 12.5, color: "var(--bad)", marginBottom: 8 }}>{panel.error}</div>
          <button className="btn btn-sm" onClick={close}>Fermer</button>
        </div>
      )}
      {panel && panel.phase === "result" && (
        <div className="selection-panel">
          <div className="selection-panel-scroll">
            <div className="soft" style={{ fontSize: 12.5, marginBottom: 6 }}>« {quote} »</div>
            <Tag variant={panel.sourceLabel === "cours" ? "good" : "ochre"}>
              {panel.sourceLabel === "cours" ? <><LIcon name="book" size={11} /> D'après le cours</> : "Hors cours — explication complémentaire"}
            </Tag>
            <div className="prose" style={{ fontSize: 15, marginTop: 8 }}>{window.renderMarkdown(panel.answer)}</div>
          </div>
          <div className="selection-panel-actions">
            <button className="btn btn-sm btn-primary" onClick={insert}><LIcon name="plus" size={13} /> Insérer ici</button>
            <button className="btn btn-sm btn-ghost" onClick={close}>Ignorer</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* languages we can display+read a course in (Piper voices + Argos packs) */
const READ_LANGS = [["fr", "Français"], ["en", "English"], ["de", "Deutsch"], ["es", "Español"], ["it", "Italiano"], ["pt", "Português"]];

/* build a translated VIEW of the chapter for its chosen display language, from
   the cached i18n overlay — titre, theme, sections, quiz, flashcards, glossary.
   The original course is never mutated, so switching back to the source is free.
   Exposed on window so every tab (Learn/Quiz/Cards) shows the same language. */
function courseView(chapter) {
  if (!chapter) return chapter;
  const lang = chapter.displayLang;
  const t = lang && chapter.i18n && chapter.i18n[lang];
  if (!t) return chapter;
  const out = {
    ...chapter,
    titre: t.titre || chapter.titre,
    theme: t.theme != null ? t.theme : chapter.theme,
    sections: (chapter.sections || []).map(s => {
      const ts = t.sections && t.sections[s.n];
      return ts ? { ...s, titre: ts.titre || s.titre, contenu: ts.contenu != null ? ts.contenu : s.contenu } : s;
    }),
  };
  if (t.quiz && Array.isArray(chapter.quiz)) {
    out.quiz = chapter.quiz.map((q, i) => t.quiz[i] ? { ...q, q: t.quiz[i].q || q.q, options: t.quiz[i].options || q.options, explication: t.quiz[i].explication != null ? t.quiz[i].explication : q.explication } : q);
  }
  if (t.cards && Array.isArray(chapter.cards)) {
    out.cards = chapter.cards.map((c, i) => t.cards[i] ? { ...c, recto: t.cards[i].recto || c.recto, verso: t.cards[i].verso != null ? t.cards[i].verso : c.verso } : c);
  }
  if (t.termes && Array.isArray(chapter.termes)) {   // keep .de (the German term), translate the rest
    out.termes = chapter.termes.map((tm, i) => t.termes[i] ? { ...tm, fr: t.termes[i].fr || tm.fr, translation: t.termes[i].translation != null ? t.termes[i].translation : tm.translation, def: t.termes[i].def != null ? t.termes[i].def : tm.def } : tm);
  }
  return out;
}
window.courseView = courseView;

/* ---------- Full lesson view for current chapter ---------- */
function LessonView({ chapter, onRetrySection, onDownload, onAddInsertion, onDeleteInsertion, onCheckBank, onAddHiddenBlock, onRestoreHiddenBlock, onTranslate, onSetDisplayLang }) {
  const done = chapter.sections.filter(s => s.status === "done").length;
  const total = chapter.sections.length;
  const [reading, setReading] = window.useState(false);
  const origLang = chapter.lang || window.getLangue() || "fr";
  const displayLang = chapter.displayLang || origLang;     // persisted on the chapter
  const [translating, setTranslating] = window.useState(false);
  const [transErr, setTransErr] = window.useState("");
  const [transProg, setTransProg] = window.useState("");
  const [langMenuOpen, setLangMenuOpen] = window.useState(false);
  window.useOutsideClose(langMenuOpen, () => setLangMenuOpen(false), ".lang-wrap");
  const view = chapter;   // already overlaid in the chosen language by window.courseView (in main.jsx)
  const curLangLabel = (READ_LANGS.find(([c]) => c === displayLang) || [null, displayLang])[1];

  async function pickLang(L) {
    setTransErr("");
    if (L === origLang || (chapter.i18n && chapter.i18n[L])) { if (onSetDisplayLang) onSetDisplayLang(chapter.id, L); return; }
    if (!onTranslate) return;
    setReading(false);                       // stop reading while content changes
    setTranslating(true); setTransProg("");
    const res = await onTranslate(chapter.id, L, (k, n) => setTransProg(k + "/" + n));
    setTranslating(false); setTransProg("");
    if (res && res.ok) { if (onSetDisplayLang) onSetDisplayLang(chapter.id, L); }
    else setTransErr((res && res.error) || "Traduction impossible.");
  }

  return (
    <div>
      <div className="lesson-head">
        <div className="lesson-meta">
          {chapter.langueSource && <Tag variant="mono">{chapter.langueSource === "de" ? window.ui("sourceDE") : chapter.langueSource === "fr" ? window.ui("sourceFR") : window.ui("sourceMX")}</Tag>}
          <Tag>{done}/{total} {window.ui("statSections")}</Tag>
          {chapter.fromFile && <Tag variant="mono"><LIcon name="file" size={12} /> {chapter.fromFile}</Tag>}
        </div>
        <div className="lesson-title-row">
          <h1 className="lesson-title">{view.titre || "Leçon en préparation…"}</h1>
          {done > 0 && (
            <button className="btn btn-sm" onClick={() => setReading(true)} title={window.ui("raListenTitle")} style={{ flex: "none", marginTop: 2 }} disabled={reading || translating}>
              <LIcon name="speaker" size={15} /> {window.ui("raListen")}
            </button>
          )}
          {done > 0 && (
            <div className="lang-wrap" style={{ position: "relative", flex: "none", marginTop: 2 }}>
              <button className="btn btn-sm" disabled={translating} aria-haspopup="listbox" aria-expanded={langMenuOpen}
                title="Afficher / lire le cours dans une autre langue" onClick={() => setLangMenuOpen(o => !o)}>
                <LIcon name="globe" size={15} /> {curLangLabel}
                {translating ? <window.Spinner size={13} /> : <LIcon name="chevrondown" size={13} />}
              </button>
              {langMenuOpen && (
                <div className="lang-menu" role="listbox">
                  {READ_LANGS.map(([code, label]) => (
                    <button key={code} className="lang-opt" role="option" aria-selected={code === displayLang} data-active={code === displayLang}
                      onClick={() => { setLangMenuOpen(false); pickLang(code); }}>
                      <span>{label}</span>
                      <span className="lang-tag">{code === origLang ? "original" : (chapter.i18n && chapter.i18n[code] ? "✓" : "")}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {done > 0 && (
            <button className="btn btn-sm" onClick={() => onDownload && onDownload(chapter.id)} title={window.ui("btnDownload")} style={{ flex: "none", marginTop: 2 }}>
              <LIcon name="download" size={15} /> {window.ui("btnDownload")}
            </button>
          )}
        </div>
        {transErr && <p className="lesson-theme" style={{ color: "var(--bad)" }}>{transErr}</p>}
        {translating && <p className="lesson-theme">Traduction du cours… {transProg} (une seule fois par langue, puis instantané)</p>}
        {view.theme && <p className="lesson-theme">{view.theme}</p>}
      </div>

      {(chapter.status === "generating" || done < total) && done < total && (
        <div style={{ marginBottom: 22 }}>
          <ProgressBar value={done} max={total} />
        </div>
      )}

      {chapter.lisible === false && (
        <Callout variant="ochre" icon="warn" title={window.ui("contentInsufficient")}>
          <p>{window.ui("contentInsufficientDesc")} {chapter.manque ? chapter.manque : ""}</p>
        </Callout>
      )}

      <Glossary termes={chapter.termes} />

      {view.sections.map(s => (
        <SectionCard key={s.n} section={s} chapter={view} onRetry={() => onRetrySection(chapter.id, s.n)}
          onAddToBank={(insId, passage) => onCheckBank(chapter.id, passage, insId)}
          onDeleteInsertion={(insId, alsoRemove) => onDeleteInsertion(chapter.id, insId, alsoRemove)}
          onRestoreHiddenBlock={(hideId) => onRestoreHiddenBlock(chapter.id, hideId)} />
      ))}

      <SelectionAssistant chapter={chapter}
        onAddHiddenBlock={(partial) => onAddHiddenBlock(chapter.id, partial)}
        onAddInsertion={(partial) => onAddInsertion(chapter.id, partial)}
        onCheckBank={(passage) => onCheckBank(chapter.id, passage, null)} />

      {chapter.aVerifier && chapter.aVerifier.length > 0 && (
        <Callout variant="ochre" icon="warn" title={window.ui("calloutVerif")}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{chapter.aVerifier.map((v, i) => <li key={i}>{v}</li>)}</ul>
        </Callout>
      )}
      {chapter.prochaineEtape && (
        <Callout variant="good" icon="next" title={window.ui("calloutNext")}>
          <p style={{ margin: 0 }}>{chapter.prochaineEtape}</p>
        </Callout>
      )}

      {reading && <window.ReadAloudBar chapter={view} lang={displayLang} onClose={() => setReading(false)} />}
    </div>
  );
}

/* ---------- The tab ---------- */
function LearnTab({ chapters, current, generating, onGenerate, onRetrySection, onSelect, onDownload, home, aiReady, onOpenSettings, onAddInsertion, onDeleteInsertion, onCheckBank, onAddHiddenBlock, onRestoreHiddenBlock, onTranslate, onSetDisplayLang }) {
  if (!current || home) {
    return (
      <div>
        <PageHead hero kicker={window.ui("learnKicker")} title={window.ui("learnTitle")}>
          {window.ui("learnDesc")}
        </PageHead>
        {aiReady
          ? <Composer onGenerate={onGenerate} generating={generating} aiReady={aiReady} onOpenSettings={onOpenSettings} />
          : <window.AiSetupCard onOpen={onOpenSettings} />}
        <div className="feature-grid">
          {[
            { i: "book", t: window.ui("feat1Title"), d: window.ui("feat1Desc") },
            { i: "warn", t: window.ui("feat2Title"), d: window.ui("feat2Desc") },
            { i: "target", t: window.ui("feat3Title"), d: window.ui("feat3Desc") },
          ].map((c, i) => (
            <window.Reveal key={i} className="card feature-card" delay={i * 90}>
              <span className="feature-ico"><LIcon name={c.i} size={22} /></span>
              <h3>{c.t}</h3>
              <p>{c.d}</p>
            </window.Reveal>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div>
      {chapters.length > 1 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 13 }}>{window.ui("chapterLabel")}</span>
          {chapters.map(ch => (
            <button key={ch.id} className={"btn btn-sm" + (ch.id === current.id ? " btn-primary" : "")} onClick={() => onSelect(ch.id)}>
              {ch.titre || "…"}
            </button>
          ))}
        </div>
      )}
      <Composer onGenerate={onGenerate} generating={generating} compact aiReady={aiReady} onOpenSettings={onOpenSettings} />
      <LessonView chapter={current} onRetrySection={onRetrySection} onDownload={onDownload} onAddInsertion={onAddInsertion} onDeleteInsertion={onDeleteInsertion} onCheckBank={onCheckBank} onAddHiddenBlock={onAddHiddenBlock} onRestoreHiddenBlock={onRestoreHiddenBlock} onTranslate={onTranslate} onSetDisplayLang={onSetDisplayLang} />
    </div>
  );
}

Object.assign(window, { Composer, LearnTab, Callout, CollapsedPassage });