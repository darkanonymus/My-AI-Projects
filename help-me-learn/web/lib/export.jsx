/* ============================================================
   export.jsx — turn a chapter into a self-contained, printable
   HTML file (works offline; the user can also print it to PDF).
   Re-renders the lesson markdown to plain HTML (escapeHTML,
   mathToHTML, inlineToHTML, blocksToHTML, mdToHTML), wraps it in
   EXPORT_CSS, and exposes the download helpers (downloadFile,
   safeName, buildExportHTML).

   This is also the single place that re-exports lib/'s public
   surface onto window — every consumer (main.jsx, learn.jsx,
   figures.jsx, library.jsx, planning.jsx, settings.jsx) reaches
   these exclusively through window.X, so this Object.assign is
   the one contract that must keep the exact same symbol list.
   ============================================================ */

/* ============================================================
   EXPORT — turn a chapter into a self-contained, printable HTML
   (works offline; user can also print it to PDF)
   ============================================================ */
function escapeHTML(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mathToHTML(tex, display) {
  try { if (window.katex) return window.katex.renderToString(tex, { displayMode: display, throwOnError: false }); } catch (e) {}
  return "<code>" + escapeHTML(tex) + "</code>";
}
function inlineToHTML(text) {
  const re = /(\$[^$]+\$)|(\*\*[^*]+\*\*)|(`[^`]+`)|(<<[^>]+>>)|(\*[^*\n]+\*)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out += escapeHTML(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("$")) out += mathToHTML(t.slice(1, -1), false);
    else if (t.startsWith("**")) out += "<strong>" + escapeHTML(t.slice(2, -2)) + "</strong>";
    else if (t.startsWith("`")) out += "<code>" + escapeHTML(t.slice(1, -1)) + "</code>";
    else if (t.startsWith("<<")) out += '<span class="term">' + escapeHTML(t.slice(2, -2)) + "</span>";
    else if (t.startsWith("*")) out += "<em>" + escapeHTML(t.slice(1, -1)) + "</em>";
    last = m.index + t.length;
  }
  if (last < text.length) out += escapeHTML(text.slice(last));
  return out;
}
function blocksToHTML(text) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  let out = "", i = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (!line.trim()) { i++; continue; }
    {
      const il = line.match(/^\s*\[img:\s*(f\d+)\s*\]\s*(.*)$/i);
      if (il) { const url = (window.HML_FIGS || {})[il[1]]; const cap = (il[2] || "").trim(); out += url ? '<figure class="figure course-fig"><img src="' + url + '" alt="' + escapeHTML(cap || "Figure du cours") + '"/><figcaption><span class="cf-tag">Figure du cours</span>' + (cap ? " · " + escapeHTML(cap) : "") + "</figcaption></figure>" : '<div class="figure">figure du cours indisponible</div>'; i++; continue; }
    }
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim().toLowerCase();
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i++; }
      i++;
      const body = buf.join("\n");
      if (lang === "fig") {
        let spec = null; try { spec = JSON.parse(body.trim()); } catch (e) { try { spec = parseJSON(body); } catch (_) {} }
        const svg = spec ? window.buildFigureSVG(spec, window.EXPORT_FIG_PALETTE) : null;
        out += svg ? '<div class="figure">' + svg + "</div>" : '<div class="figure">schéma non disponible</div>';
      } else if (lang === "img") {
        const r = window.parseImgRef(body); const url = (window.HML_FIGS || {})[r.id];
        out += url
          ? '<figure class="figure course-fig"><img src="' + url + '" alt="' + escapeHTML(r.caption || "Figure du cours") + '"/><figcaption><span class="cf-tag">Figure du cours</span>' + (r.caption ? " · " + escapeHTML(r.caption) : "") + "</figcaption></figure>"
          : '<div class="figure">figure du cours indisponible</div>';
      } else {
        out += "<pre class=\"code\"><code>" + escapeHTML(body) + "</code></pre>";
      }
      continue;
    }
    if (line.trim().startsWith("$$")) {
      let buf = line.trim().slice(2);
      if (buf.trim().endsWith("$$")) buf = buf.trim().slice(0, -2);
      else { i++; while (i < lines.length && !lines[i].includes("$$")) { buf += "\n" + lines[i]; i++; } if (i < lines.length) buf += "\n" + lines[i].replace("$$", ""); }
      out += '<div class="math-block">' + mathToHTML(buf.trim(), true) + "</div>"; i++; continue;
    }
    if (/^#{1,6}\s+/.test(line)) { out += "<h4>" + inlineToHTML(line.replace(/^[#\s]+/, "")) + "</h4>"; i++; continue; }
    if (/^\s*[-•*]\s+/.test(line)) { let it = []; while (i < lines.length && /^\s*[-•*]\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*[-•*]\s+/, "")); i++; } out += "<ul>" + it.map(x => "<li>" + inlineToHTML(x) + "</li>").join("") + "</ul>"; continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { let it = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; } out += "<ol>" + it.map(x => "<li>" + inlineToHTML(x) + "</li>").join("") + "</ol>"; continue; }
    let para = line; i++;
    while (i < lines.length && lines[i].trim() && !/^\s*[-•*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !lines[i].trim().startsWith("$$") && !lines[i].trim().startsWith("```") && !/^#{1,6}\s+/.test(lines[i])) { para += " " + lines[i]; i++; }
    out += "<p>" + inlineToHTML(para) + "</p>";
  }
  return out;
}
function mdToHTML(src) {
  if (!src) return "";
  const parts = src.split(/(\[\[C\]\][\s\S]*?\[\[\/C\]\])/g);
  let html = "";
  parts.forEach(part => {
    if (!part) return;
    if (part.startsWith("[[C]]")) {
      const inner = part.replace(/^\[\[C\]\]/, "").replace(/\[\[\/C\]\]$/, "").trim();
      html += '<div class="complement"><div class="complement-label">+ Complément ajouté (hors cours)</div>' + blocksToHTML(inner) + "</div>";
    } else html += blocksToHTML(part);
  });
  return html;
}

const EXPORT_CSS = `
*{box-sizing:border-box}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:#1f2430;background:#fff;line-height:1.7;margin:0;font-size:16px}
main{max-width:760px;margin:0 auto;padding:56px 28px 80px}
.doc-head{border-bottom:2px solid #ece9f5;padding-bottom:22px;margin-bottom:32px}
.kicker{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7c5cff;margin-bottom:10px}
h1{font-family:'Space Grotesk',system-ui,sans-serif;font-size:34px;line-height:1.15;margin:0 0 8px;letter-spacing:-.02em}
.theme{color:#5b6170;font-size:18px;margin:0}
h2{font-family:'Space Grotesk',system-ui,sans-serif;font-size:22px;margin:38px 0 12px;letter-spacing:-.01em;display:flex;align-items:center;gap:12px}
.num{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;background:#7c5cff;color:#fff;font-size:15px;flex:none}
h3{font-family:'Space Grotesk',system-ui,sans-serif;font-size:17px;margin:0 0 8px}
h4{font-size:16px;margin:18px 0 6px}
.prose p{margin:0 0 .8em}
.prose ul,.prose ol{margin:.3em 0 .9em;padding-left:1.4em}
.prose li{margin:.3em 0}
code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:.85em;background:#f3f1fa;border:1px solid #e6e2f3;padding:1px 5px;border-radius:5px}
.term{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:.86em;color:#5b3ee0;background:#f3f0ff;border-bottom:1.5px solid #d8cffb;padding:0 4px;border-radius:4px}
.math-block{margin:.9em 0;overflow-x:auto}
.figure{margin:1.1em 0;border:1px solid #ece9f5;border-radius:12px;background:#fbfaff;padding:12px 14px;overflow:hidden;page-break-inside:avoid}
.figure svg{display:block;width:100%;height:auto}
.figure.course-fig{text-align:center}
.figure.course-fig img{max-width:100%;max-height:460px;border-radius:7px;display:block;margin:0 auto}
.figure.course-fig figcaption{font-size:12px;color:#5b6170;margin-top:7px}
.figure.course-fig .cf-tag{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#5b3ee0}
.glo table{width:100%;border-collapse:collapse;font-size:14.5px}
.glo td{padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top}
.glo .de{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:600;color:#5b3ee0;white-space:nowrap}
.glo .fr{font-weight:600;white-space:nowrap}
.glo .def{color:#5b6170}
.complement{margin:.9em 0;padding:12px 16px;border-left:3px solid #e08a2e;background:#fdf3e6;border-radius:0 10px 10px 0;font-size:15px}
.complement-label{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#b56a16;margin-bottom:5px}
.sec{page-break-inside:avoid}
.q{margin:0 0 16px;padding:14px 16px;border:1px solid #ece9f5;border-radius:12px}
.qq{margin:0 0 8px}
.opts{margin:0;padding-left:20px}
.opts .ok{color:#0f9d58;font-weight:600}
.exp{font-size:14px;color:#5b6170;margin:8px 0 0;font-style:italic}
.fc{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #ece9f5;border-radius:10px;overflow:hidden;margin:0 0 10px}
.fc .r{padding:12px 14px;font-weight:600;background:#faf9ff;border-right:1px solid #ece9f5}
.fc .v{padding:12px 14px}
.callout{margin:26px 0 0;padding:16px 18px;border-radius:12px}
.callout h3{margin:0 0 6px}
.callout.warn{background:#fdf3e6;border:1px solid #f2dcb8}
.callout.warn h3{color:#b56a16}
.callout.next{background:#e9fbf2;border:1px solid #b9ecd2}
.callout.next h3{color:#0f9d58}
footer{margin-top:46px;padding-top:18px;border-top:1px solid #eee;font-size:13px;color:#9aa0ad;text-align:center}
@media print{body{font-size:12pt}main{padding:0}.q,.sec{page-break-inside:avoid}}
`;

function buildExportHTML(ch) {
  const esc = escapeHTML;
  const glo = (ch.termes && ch.termes.length)
    ? `<section class="glo"><h2>Glossaire</h2><table>${ch.termes.map(t => `<tr><td class="de">${esc(t.de)}</td><td class="fr">${esc(t.fr)}</td><td class="def">${esc(t.def || "")}</td></tr>`).join("")}</table></section>` : "";
  const secs = ch.sections.filter(s => s.status === "done")
    .map(s => `<section class="sec"><h2><span class="num">${s.n}</span>${esc(s.titre)}</h2><div class="prose">${mdToHTML(s.contenu)}</div></section>`).join("");
  const quiz = (ch.quiz && ch.quiz.length)
    ? `<section class="sec"><h2>Quiz — corrigé</h2>${ch.quiz.map((q, i) => `<div class="q"><p class="qq"><b>Q${i + 1}.</b> ${esc(q.q)}</p><ol class="opts">${q.options.map((o, j) => `<li class="${j === q.correct ? "ok" : ""}">${esc(o)}${j === q.correct ? " ✓" : ""}</li>`).join("")}</ol>${q.explication ? `<p class="exp">${esc(q.explication)}</p>` : ""}</div>`).join("")}</section>` : "";
  const cards = (ch.cards && ch.cards.length)
    ? `<section class="sec"><h2>Flashcards</h2>${ch.cards.map(c => `<div class="fc"><div class="r">${inlineToHTML(c.recto)}</div><div class="v">${inlineToHTML(c.verso)}</div></div>`).join("")}</section>` : "";
  const verif = (ch.aVerifier && ch.aVerifier.length)
    ? `<section class="callout warn"><h3>À vérifier dans ton cours ou auprès du prof</h3><ul>${ch.aVerifier.map(v => `<li>${esc(v)}</li>`).join("")}</ul></section>` : "";
  const next = ch.prochaineEtape
    ? `<section class="callout next"><h3>Pour continuer efficacement, fournis ensuite :</h3><p>${esc(ch.prochaineEtape)}</p></section>` : "";
  const date = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ch.titre || "Cours")}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"><style>${EXPORT_CSS}</style></head><body><main><header class="doc-head"><div class="kicker">Help me Learn · Leçon · ${esc(date)}</div><h1>${esc(ch.titre || "Cours")}</h1>${ch.theme ? `<p class="theme">${esc(ch.theme)}</p>` : ""}</header>${glo}${secs}${quiz}${cards}${verif}${next}<footer>Généré avec Help me Learn — à confronter à ton cours et au corrigé du professeur.</footer></main></body></html>`;
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function safeName(s) {
  return (s || "cours").toLowerCase().replace(/[^a-z0-9àâäéèêëîïôöùûüç\s-]/gi, "").trim().replace(/\s+/g, "-").slice(0, 50) || "cours";
}

/* export to window for other babel modules */
Object.assign(window, {
  SECTIONS, METHODE_BODY, buildMethode, callClaude,
  buildIntroPrompt, buildSectionPrompt, buildQuizPrompt, buildFlashPrompt, buildClosingPrompt,
  buildAskPrompt, buildExamplePrompt, buildBankCheckPrompt,
  buildPriorContext, buildExerciseListPrompt, buildSingleExercisePrompt, buildNoExercisePrompt,
  parseJSON, extractFromPDF, extractFromImage,
  renderMarkdown, PLAN_PHASES, buildPlanPhases, buildPlan,
  buildExportHTML, downloadFile, safeName, mdToHTML,
  getApiKey, setApiKey, aiMode, hasPlatformAI,
  getProvider, setProvider, getOllamaModel, setOllamaModel, getClaudeModel, setClaudeModel, getGeminiModel, setGeminiModel, serverHealth,
  getNiveau, setNiveau, getLangue, setLangue,
  getPlanEnabled, setPlanEnabled, getPlanDays, setPlanDays,
  getEnabledSections, setEnabledSections,
  getSectionLabels, buildLangTail, ui, UI_STRINGS, SECTION_I18N,
  callClaudeStream,
});
