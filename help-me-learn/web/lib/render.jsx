/* ============================================================
   render.jsx — markdown-lite + KaTeX renderer
   Turns lesson markdown into React nodes. Supports paragraphs,
   **bold**, *italic*, `code`, <<term>>, "- "/"1. " lists,
   "#### " headings, $inline$ & $$block$$ math, and
   [[C]]...[[/C]] complement callouts.
   ============================================================ */

/* ============================================================
   MARKDOWN-LITE + KaTeX RENDERER  → returns array of React nodes
   Supports: paragraphs, **bold**, *italic*, `code`, <<term>>,
   - / 1. lists, #### headings, $inline$ & $$block$$ math,
   [[C]]...[[/C]] complement callouts.
   ============================================================ */
function renderMath(tex, display) {
  try {
    if (window.katex) {
      const html = window.katex.renderToString(tex, { displayMode: display, throwOnError: false });
      return <span className={display ? "math-block" : ""} dangerouslySetInnerHTML={{ __html: html }} />;
    }
  } catch (e) {}
  return <code>{tex}</code>;
}

/* inline parser: bold, italic, code, term, inline math */
function renderInline(text, keyBase) {
  const nodes = [];
  // tokenizer over special spans
  const re = /(\$[^$]+\$)|(\*\*[^*]+\*\*)|(`[^`]+`)|(<<[^>]+>>)|(\*[^*\n]+\*)/g;
  let last = 0, m, idx = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = keyBase + "-" + (idx++);
    if (tok.startsWith("$")) nodes.push(<React.Fragment key={k}>{renderMath(tok.slice(1, -1), false)}</React.Fragment>);
    else if (tok.startsWith("**")) nodes.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) nodes.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("<<")) nodes.push(<span className="term" key={k}>{tok.slice(2, -2)}</span>);
    else if (tok.startsWith("*")) nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* block parser */
function renderMarkdown(src) {
  if (!src) return null;
  // normalize, then handle complements as blocks
  const blocks = [];
  // split on complement markers keeping them
  const parts = src.split(/(\[\[C\]\][\s\S]*?\[\[\/C\]\])/g);
  let bkey = 0;
  parts.forEach(part => {
    if (!part) return;
    if (part.startsWith("[[C]]")) {
      const inner = part.replace(/^\[\[C\]\]/, "").replace(/\[\[\/C\]\]$/, "").trim();
      blocks.push(
        <div className="complement" key={"cmp" + (bkey++)}>
          <div className="complement-label">＋ Complément ajouté (hors cours)</div>
          {renderBlocks(inner, "cmp" + bkey)}
        </div>
      );
    } else {
      blocks.push(<React.Fragment key={"b" + (bkey++)}>{renderBlocks(part, "b" + bkey)}</React.Fragment>);
    }
  });
  return blocks;
}

function renderBlocks(text, kb) {
  const out = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0, k = 0;
  while (i < lines.length) {
    let line = lines[i];
    // blank
    if (!line.trim()) { i++; continue; }
    // standalone original-image reference: [img:fN] optional caption
    {
      const il = line.match(/^\s*\[img:\s*(f\d+)\s*\]\s*(.*)$/i);
      if (il) { out.push(<window.ImageBlock key={kb + "imL" + (k++)} id={il[1]} caption={(il[2] || "").trim()} />); i++; continue; }
    }
    // fenced block ```fig ... ``` (figure) or plain code
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim().toLowerCase();
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      const body = buf.join("\n");
      if (lang === "fig") out.push(<window.FigureBlock key={kb + "fig" + (k++)} src={body} />);
      else if (lang === "img") { const r = window.parseImgRef(body); out.push(<window.ImageBlock key={kb + "img" + (k++)} id={r.id} caption={r.caption} />); }
      else out.push(<pre key={kb + "pre" + (k++)} style={{ overflowX: "auto", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}><code className="mono">{body}</code></pre>);
      continue;
    }
    // block math $$...$$ (possibly multi-line)
    if (line.trim().startsWith("$$")) {
      let buf = line.trim().slice(2);
      if (buf.trim().endsWith("$$")) { buf = buf.trim().slice(0, -2); }
      else { i++; while (i < lines.length && !lines[i].includes("$$")) { buf += "\n" + lines[i]; i++; } if (i < lines.length) buf += "\n" + lines[i].replace("$$", ""); }
      out.push(<div className="math-block" key={kb + "m" + (k++)}>{renderMath(buf.trim(), true)}</div>);
      i++; continue;
    }
    // heading (#–####), tolerate stray leading #
    if (/^#{1,6}\s+/.test(line)) {
      out.push(<h4 key={kb + "h" + (k++)}>{renderInline(line.replace(/^[#\s]+/, ""), kb + "h" + k)}</h4>);
      i++; continue;
    }
    // unordered list
    if (/^\s*[-•*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-•*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-•*]\s+/, "")); i++;
      }
      out.push(<ul key={kb + "u" + (k++)}>{items.map((it, j) => <li key={j}>{renderInline(it, kb + "ui" + k + j)}</li>)}</ul>);
      continue;
    }
    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++;
      }
      out.push(<ol key={kb + "o" + (k++)}>{items.map((it, j) => <li key={j}>{renderInline(it, kb + "oi" + k + j)}</li>)}</ol>);
      continue;
    }
    // paragraph (gather until blank)
    let para = line;
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*[-•*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !lines[i].trim().startsWith("$$") && !lines[i].trim().startsWith("```") && !/^#{1,6}\s+/.test(lines[i])) {
      para += " " + lines[i]; i++;
    }
    out.push(<p key={kb + "p" + (k++)}>{renderInline(para, kb + "p" + k)}</p>);
  }
  return out;
}

