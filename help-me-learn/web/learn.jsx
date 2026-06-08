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
    <div className="card" style={{ padding: compact ? 16 : 22, marginBottom: compact ? 20 : 0 }}>
      {!aiReady && (
        <div style={{ marginBottom: 14, padding: "11px 14px", borderRadius: 10, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", fontSize: 13.5, color: "var(--accent-deep)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1 }}>Choisis un moteur d'IA pour activer la génération.</span>
          <button className="btn btn-sm btn-primary" onClick={onOpenSettings}><LIcon name="spark" size={13} /> Choisir le moteur</button>
        </div>
      )}
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <Tag variant="accent"><LIcon name="spark" size={13} /> Nouveau chapitre</Tag>
          <span className="muted" style={{ fontSize: 13 }}>{window.ui("btnImport").replace("Importer ","")} PDF / image</span>
        </div>
      )}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={window.ui("composerPlaceholder")}
        rows={compact ? 3 : 6}
        disabled={busy}
        style={{
          width: "100%", resize: "vertical", border: "1px solid var(--line)", borderRadius: 11,
          padding: "13px 15px", fontFamily: "var(--font-sans)", fontSize: 15.5, lineHeight: 1.6,
          background: "var(--paper)", color: "var(--ink)", outline: "none", minHeight: compact ? 70 : 130,
        }}
      />
      {fileName && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9, fontSize: 13, color: "var(--ink-soft)" }}>
          <LIcon name={/\.pdf$/i.test(fileName) ? "file" : "image"} size={15} />
          <span className="mono">{fileName}</span>
        </div>
      )}
      {status && <div style={{ marginTop: 10, fontSize: 13.5, color: "var(--accent-deep)", display: "flex", gap: 8, alignItems: "center" }}>{extracting && <Spinner size={14} />}{status}</div>}
      {warn && (
        <div style={{ marginTop: 11, padding: "10px 13px", background: "var(--ochre-soft)", border: "1px solid var(--ochre-line)", borderRadius: 9, fontSize: 13.5, color: "var(--ochre-deep)", display: "flex", gap: 9 }}>
          <span style={{ flex: "none", marginTop: 1 }}><LIcon name="warn" size={15} /></span><span>{warn}</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
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
    <div className="card" style={{ padding: "16px 18px", marginBottom: 22 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 12 }}>
        {window.ui("glossaryTitle")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 11 }}>
        {termes.map((t, i) => (
          <div key={i} style={{ background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: "var(--radius-sm)", padding: "9px 12px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: 14, color: "var(--accent-deep)" }}>{t.de}</span>
              <span style={{ fontSize: 13.5, color: "var(--ink-soft)" }}>→ {t.fr}</span>
            </div>
            {t.def && <div className="soft" style={{ fontSize: 13, marginTop: 2, lineHeight: 1.5 }}>{t.def}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- One lesson section card ---------- */
function SectionCard({ section, onRetry }) {
  const { n, titre, court, status, contenu, err } = section;
  return (
    <section className="card section-card fade-in" data-status={status} style={{ padding: "20px 22px 20px 25px", marginBottom: 14 }} data-screen-label={"Section " + n}>
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
      {status === "loading" && contenu && <div className="prose">{window.renderMarkdown(contenu)}</div>}
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
      {status === "done" && <div className="prose">{window.renderMarkdown(contenu)}</div>}
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

/* ---------- Full lesson view for current chapter ---------- */
function LessonView({ chapter, onRetrySection, onDownload }) {
  const done = chapter.sections.filter(s => s.status === "done").length;
  const total = chapter.sections.length;
  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {chapter.langueSource && <Tag variant="mono">{chapter.langueSource === "de" ? window.ui("sourceDE") : chapter.langueSource === "fr" ? window.ui("sourceFR") : window.ui("sourceMX")}</Tag>}
          <Tag>{done}/{total} {window.ui("statSections")}</Tag>
          {chapter.fromFile && <Tag variant="mono"><LIcon name="file" size={12} /> {chapter.fromFile}</Tag>}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <h1 style={{ margin: "0 0 6px", fontSize: 30, lineHeight: 1.12, flex: 1, minWidth: 220 }}>{chapter.titre || "Leçon en préparation…"}</h1>
          {done > 0 && (
            <button className="btn btn-sm" onClick={() => onDownload && onDownload(chapter.id)} title={window.ui("btnDownload")} style={{ flex: "none", marginTop: 2 }}>
              <LIcon name="download" size={15} /> {window.ui("btnDownload")}
            </button>
          )}
        </div>
        {chapter.theme && <p className="soft" style={{ margin: 0, fontSize: 16.5, maxWidth: 680 }}>{chapter.theme}</p>}
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

      {chapter.sections.map(s => (
        <SectionCard key={s.n} section={s} onRetry={() => onRetrySection(chapter.id, s.n)} />
      ))}

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
    </div>
  );
}

/* ---------- The tab ---------- */
function LearnTab({ chapters, current, generating, onGenerate, onRetrySection, onSelect, onDownload, home, aiReady, onOpenSettings }) {
  if (!current || home) {
    return (
      <div>
        <PageHead kicker={window.ui("learnKicker")} title={window.ui("learnTitle")}>
          {window.ui("learnDesc")}
        </PageHead>
        {aiReady
          ? <Composer onGenerate={onGenerate} generating={generating} aiReady={aiReady} onOpenSettings={onOpenSettings} />
          : <window.AiSetupCard onOpen={onOpenSettings} />}
        <div style={{ marginTop: 26 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 14 }}>
            {[
              { i: "book", t: window.ui("feat1Title"), d: window.ui("feat1Desc") },
              { i: "warn", t: window.ui("feat2Title"), d: window.ui("feat2Desc") },
              { i: "target", t: window.ui("feat3Title"), d: window.ui("feat3Desc") },
            ].map((c, i) => (
              <div key={i} className="card" style={{ padding: 18 }}>
                <span style={{ color: "var(--accent)" }}><LIcon name={c.i} size={22} /></span>
                <h3 style={{ margin: "10px 0 5px", fontSize: 16.5 }}>{c.t}</h3>
                <p className="soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{c.d}</p>
              </div>
            ))}
          </div>
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
      <LessonView chapter={current} onRetrySection={onRetrySection} onDownload={onDownload} />
    </div>
  );
}

Object.assign(window, { Composer, LearnTab, Callout });