/* ============================================================
   figures.jsx — deterministic diagram engine
   The AI emits a ```fig <json>``` block; we render it as a clean
   SVG (no hallucinated hand-drawn SVG). Two types:
     • "plot" — cartesian axes, curves (expr), points, lines, v/h lines
     • "flow" — vertical step/algorithm schema with arrows
   Used both in-app (FigureBlock) and in export (buildFigureSVG string).
   ============================================================ */

function _esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ---- safe math expression compiler: returns f(x) or null ----
   Supports: numbers, x, pi, e, + - * / ^, unary -, parentheses,
   functions sin cos tan exp sqrt abs ln log log2. Explicit operators only. */
function compileExpr(src) {
  if (!src || typeof src !== "string") return null;
  const re = /([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)|([A-Za-zπ_][A-Za-z0-9_]*)|(\*\*)|([-+*/^(),])/g;
  const toks = []; let m;
  while ((m = re.exec(src)) !== null) toks.push(m[3] ? "^" : m[0]);
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const FUN = { sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: (v) => Math.log(v) / Math.LN10, log2: Math.log2 || ((v) => Math.log(v) / Math.LN2) };
  function prim() {
    let t = peek();
    if (t === "(") { next(); const e = expr(); if (peek() === ")") next(); return e; }
    if (t === "-") { next(); const e = prim(); return (x) => -e(x); }
    if (t === "+") { next(); return prim(); }
    if (t != null && /^[0-9.]/.test(t)) { next(); const n = parseFloat(t); return () => n; }
    if (t != null && /^[A-Za-zπ_]/.test(t)) {
      next();
      if (t === "x" || t === "X") return (x) => x;
      if (t === "pi" || t === "PI" || t === "π") return () => Math.PI;
      if (t === "e") return () => Math.E;
      if (FUN[t]) { if (peek() === "(") { next(); const a = expr(); if (peek() === ")") next(); const f = FUN[t]; return (x) => f(a(x)); } }
      return () => NaN;
    }
    return () => NaN;
  }
  function powExpr() { const b = prim(); if (peek() === "^") { next(); const e = powExpr(); return (x) => Math.pow(b(x), e(x)); } return b; }
  function term() { let v = powExpr(); while (peek() === "*" || peek() === "/") { const op = next(); const r = powExpr(); const prev = v; v = op === "*" ? (x) => prev(x) * r(x) : (x) => prev(x) / r(x); } return v; }
  function expr() { let v = term(); while (peek() === "+" || peek() === "-") { const op = next(); const r = term(); const prev = v; v = op === "+" ? (x) => prev(x) + r(x) : (x) => prev(x) - r(x); } return v; }
  try { const f = expr(); if (typeof f(1) !== "number") return null; return f; } catch (e) { return null; }
}

const APP_FIG_PALETTE = { ink: "var(--ink)", soft: "var(--ink-soft)", faint: "var(--ink-faint)", grid: "var(--line)", frame: "var(--line-strong)", surface: "var(--surface)", headBg: "var(--accent-soft)", headInk: "var(--accent-deep)", zebra: "var(--surface-2)", tint: "var(--accent-soft)", series: ["var(--accent)", "var(--ochre)", "var(--good)", "var(--accent-2)"] };
const EXPORT_FIG_PALETTE = { ink: "#1f2430", soft: "#5b6170", faint: "#9aa0ad", grid: "#e8e5f0", frame: "#cfc9dd", surface: "#ffffff", headBg: "#f1edff", headInk: "#5b3ee0", zebra: "#faf9ff", tint: "#f3f0ff", series: ["#5b3ee0", "#d98324", "#0f9d58", "#2a93c7"] };

function _ticks(a, b, count) {
  const span = b - a; if (!(span > 0)) return [a];
  const raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
  let step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const arr = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) arr.push(+v.toFixed(8));
  return arr;
}
function _fmt(v) { if (v === 0) return "0"; if (Math.abs(v) >= 10000 || Math.abs(v) < 0.01) return v.toExponential(1); return (+v.toFixed(2)).toString(); }

function figPlot(spec, pal) {
  const W = 620, H = 380, m = { l: 56, r: 18, t: spec.titre ? 44 : 18, b: spec.xLabel ? 48 : 34 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const series = (Array.isArray(spec.series) ? spec.series : []).map(s => {
    if ((s.kind === "curve" || (s.expr && !s.kind)) && s.expr) return { ...s, kind: "curve", f: compileExpr(s.expr) };
    return s;
  });
  let xmin = null, xmax = null;
  if (Array.isArray(spec.domain) && spec.domain.length === 2) { xmin = +spec.domain[0]; xmax = +spec.domain[1]; }
  const dataXs = [], dataYs = [];
  series.forEach(s => {
    if (s.kind === "points" && Array.isArray(s.data)) s.data.forEach(p => { dataXs.push(+p[0]); dataYs.push(+p[1]); });
    if (s.kind === "line" && Array.isArray(s.data)) s.data.forEach(p => { dataXs.push(+p[0]); dataYs.push(+p[1]); });
    if (s.kind === "vline" && s.x != null) dataXs.push(+s.x);
    if (s.kind === "hline" && s.y != null) dataYs.push(+s.y);
  });
  if (xmin == null || xmax == null) {
    if (dataXs.length) { xmin = Math.min(...dataXs); xmax = Math.max(...dataXs); const pad = (xmax - xmin) || 1; xmin -= pad * 0.18; xmax += pad * 0.18; }
    else { xmin = -5; xmax = 5; }
  }
  if (!(xmax > xmin)) xmax = xmin + 1;
  const N = 200;
  series.forEach(s => { if (s.kind === "curve" && s.f) { const pts = []; for (let k = 0; k <= N; k++) { const x = xmin + (xmax - xmin) * k / N; let y; try { y = s.f(x); } catch (e) { y = NaN; } pts.push([x, y]); if (isFinite(y)) dataYs.push(y); } s._pts = pts; } });
  let ymin, ymax;
  if (Array.isArray(spec.yDomain) && spec.yDomain.length === 2) { ymin = +spec.yDomain[0]; ymax = +spec.yDomain[1]; }
  else if (dataYs.length) { ymin = Math.min(...dataYs); ymax = Math.max(...dataYs); const pad = (ymax - ymin) || 1; ymin -= pad * 0.14; ymax += pad * 0.14; }
  else { ymin = -5; ymax = 5; }
  if (!(ymax > ymin)) ymax = ymin + 1;
  const X = (x) => m.l + (x - xmin) / (xmax - xmin) * pw;
  const Y = (y) => m.t + ph - (y - ymin) / (ymax - ymin) * ph;
  const xt = _ticks(xmin, xmax, 7), yt = _ticks(ymin, ymax, 6);
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
  svg += `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="${pal.frame}" stroke-width="1"/>`;
  xt.forEach(v => { const px = X(v); svg += `<line x1="${px.toFixed(1)}" y1="${m.t}" x2="${px.toFixed(1)}" y2="${m.t + ph}" stroke="${pal.grid}" stroke-width="1"/><text x="${px.toFixed(1)}" y="${m.t + ph + 16}" text-anchor="middle" font-size="11" fill="${pal.faint}">${_fmt(v)}</text>`; });
  yt.forEach(v => { const py = Y(v); svg += `<line x1="${m.l}" y1="${py.toFixed(1)}" x2="${m.l + pw}" y2="${py.toFixed(1)}" stroke="${pal.grid}" stroke-width="1"/><text x="${m.l - 8}" y="${(py + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${pal.faint}">${_fmt(v)}</text>`; });
  if (0 >= ymin && 0 <= ymax) { const py = Y(0); svg += `<line x1="${m.l}" y1="${py.toFixed(1)}" x2="${m.l + pw}" y2="${py.toFixed(1)}" stroke="${pal.soft}" stroke-width="1.5"/>`; }
  if (0 >= xmin && 0 <= xmax) { const px = X(0); svg += `<line x1="${px.toFixed(1)}" y1="${m.t}" x2="${px.toFixed(1)}" y2="${m.t + ph}" stroke="${pal.soft}" stroke-width="1.5"/>`; }
  let ci = 0; const legend = [];
  series.forEach(s => {
    const col = s.color || pal.series[ci % pal.series.length];
    if (s.kind !== "hline" && s.kind !== "vline") ci++;
    if (s.kind === "curve" && s._pts) {
      let d = "", down = false;
      s._pts.forEach(([x, y]) => { if (isFinite(y) && y >= ymin && y <= ymax) { d += (down ? "L" : "M") + X(x).toFixed(1) + " " + Y(y).toFixed(1) + " "; down = true; } else down = false; });
      svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>`;
      if (s.label) legend.push([s.label, col]);
    } else if (s.kind === "points" && Array.isArray(s.data)) {
      s.data.forEach(p => { svg += `<circle cx="${X(+p[0]).toFixed(1)}" cy="${Y(+p[1]).toFixed(1)}" r="4.5" fill="${col}" stroke="${pal.surface}" stroke-width="1.5"/>`; });
      if (s.label) legend.push([s.label, col]);
    } else if (s.kind === "line" && Array.isArray(s.data) && s.data.length >= 2) {
      let d = ""; s.data.forEach((p, idx) => { d += (idx ? "L" : "M") + X(+p[0]).toFixed(1) + " " + Y(+p[1]).toFixed(1) + " "; });
      svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.5"/>`;
      if (s.label) legend.push([s.label, col]);
    } else if (s.kind === "vline" && s.x != null) { const px = X(+s.x); svg += `<line x1="${px.toFixed(1)}" y1="${m.t}" x2="${px.toFixed(1)}" y2="${m.t + ph}" stroke="${col}" stroke-width="1.8" stroke-dasharray="5 4"/>`; if (s.label) legend.push([s.label, col]); }
    else if (s.kind === "hline" && s.y != null) { const py = Y(+s.y); svg += `<line x1="${m.l}" y1="${py.toFixed(1)}" x2="${m.l + pw}" y2="${py.toFixed(1)}" stroke="${col}" stroke-width="1.8" stroke-dasharray="5 4"/>`; if (s.label) legend.push([s.label, col]); }
  });
  if (spec.xLabel) svg += `<text x="${m.l + pw / 2}" y="${H - 8}" text-anchor="middle" font-size="12" fill="${pal.soft}">${_esc(spec.xLabel)}</text>`;
  if (spec.yLabel) svg += `<text x="15" y="${m.t + ph / 2}" text-anchor="middle" font-size="12" fill="${pal.soft}" transform="rotate(-90 15 ${m.t + ph / 2})">${_esc(spec.yLabel)}</text>`;
  if (spec.titre) svg += `<text x="${m.l}" y="24" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
  legend.slice(0, 4).forEach((l, idx) => { const lx = m.l + pw - 10, ly = m.t + 15 + idx * 17; svg += `<line x1="${lx - 26}" y1="${ly - 4}" x2="${lx - 10}" y2="${ly - 4}" stroke="${l[1]}" stroke-width="3"/><text x="${lx - 30}" y="${ly}" text-anchor="end" font-size="11" fill="${pal.soft}">${_esc(l[0])}</text>`; });
  svg += `</svg>`;
  return svg;
}

function _wrap(str, maxc) {
  const words = String(str).split(/\s+/); const lines = []; let cur = "";
  words.forEach(w => { if ((cur + " " + w).trim().length > maxc) { if (cur) lines.push(cur); cur = w; } else cur = (cur ? cur + " " : "") + w; });
  if (cur) lines.push(cur); return lines.length ? lines : [""];
}
function figFlow(spec, pal) {
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const W = 620, bw = 470, bx = (W - bw) / 2, pad = 13, lh = 19, maxc = 56, gap = 28;
  let y = spec.titre ? 42 : 14; const layout = [];
  nodes.forEach(n => { const lines = _wrap(typeof n === "object" ? (n.label || "") : n, maxc); const bh = lines.length * lh + pad * 2; layout.push({ y, bh, lines }); y += bh + gap; });
  const H = Math.max(60, y - gap + 14);
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
  if (spec.titre) svg += `<text x="${bx}" y="26" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
  layout.forEach((b, idx) => {
    const col = pal.series[idx % pal.series.length];
    svg += `<rect x="${bx}" y="${b.y}" width="${bw}" height="${b.bh}" rx="11" fill="${pal.surface}" stroke="${col}" stroke-width="1.5"/>`;
    svg += `<rect x="${bx}" y="${b.y}" width="5" height="${b.bh}" rx="2.5" fill="${col}"/>`;
    b.lines.forEach((ln, li) => { svg += `<text x="${bx + 18}" y="${b.y + pad + 14 + li * lh}" font-size="13.5" fill="${pal.ink}">${_esc(ln)}</text>`; });
    if (idx < layout.length - 1) { const ay = b.y + b.bh, ny = layout[idx + 1].y, cx = W / 2; svg += `<line x1="${cx}" y1="${ay}" x2="${cx}" y2="${ny}" stroke="${pal.soft}" stroke-width="1.8"/><path d="M${cx - 5} ${ny - 7} L${cx} ${ny} L${cx + 5} ${ny - 7}" fill="none" stroke="${pal.soft}" stroke-width="1.8"/>`; }
  });
  svg += `</svg>`;
  return svg;
}

function _maxLen(lines) { let m = 0; lines.forEach(l => { if (l.length > m) m = l.length; }); return m; }

/* ---------------- BARS — histogramme / comparaison ---------------- */
function figBars(spec, pal) {
  const data = (Array.isArray(spec.data) ? spec.data : []).map(d => ({ label: String(d && d.label != null ? d.label : ""), value: +(d && d.value) || 0, color: d && d.color }));
  if (!data.length) return null;
  const longest = Math.max(...data.map(d => d.label.length));
  const horizontal = spec.horizontal != null ? !!spec.horizontal : (data.length > 7 || longest > 11);
  const W = 620;
  const vmax = Math.max(0, ...data.map(d => d.value)), vmin = Math.min(0, ...data.map(d => d.value));
  const span = (vmax - vmin) || 1;
  let svg = "";
  if (horizontal) {
    const labW = Math.min(170, Math.max(60, longest * 6.6 + 12));
    const m = { l: labW, r: 44, t: spec.titre ? 40 : 12, b: 12 }, rowH = 30, gap = 10;
    const pw = W - m.l - m.r, H = m.t + data.length * (rowH + gap) - gap + m.b;
    const X = v => m.l + (v - vmin) / span * pw;
    svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
    if (spec.titre) svg += `<text x="0" y="22" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
    const zx = X(0);
    data.forEach((d, i) => {
      const y = m.t + i * (rowH + gap), col = d.color || pal.series[i % pal.series.length];
      const x0 = Math.min(zx, X(d.value)), bw = Math.abs(X(d.value) - zx);
      svg += `<rect x="${x0.toFixed(1)}" y="${y}" width="${Math.max(1, bw).toFixed(1)}" height="${rowH}" rx="4" fill="${col}"/>`;
      svg += `<text x="${(m.l - 8)}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12.5" fill="${pal.ink}">${_esc(d.label)}</text>`;
      svg += `<text x="${(X(d.value) + (d.value < 0 ? -6 : 6)).toFixed(1)}" y="${y + rowH / 2 + 4}" text-anchor="${d.value < 0 ? "end" : "start"}" font-size="12" font-weight="600" fill="${pal.soft}">${_fmt(d.value)}</text>`;
    });
    svg += `<line x1="${zx.toFixed(1)}" y1="${m.t}" x2="${zx.toFixed(1)}" y2="${m.t + data.length * (rowH + gap) - gap}" stroke="${pal.frame}" stroke-width="1.5"/>`;
    svg += `</svg>`; return svg;
  }
  const m = { l: 46, r: 14, t: spec.titre ? 40 : 14, b: 44 }, ph = 230, pw = W - m.l - m.r, H = m.t + ph + m.b;
  const Y = v => m.t + ph - (v - vmin) / span * ph;
  const slot = pw / data.length, bw = Math.min(70, slot * 0.6);
  svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
  if (spec.titre) svg += `<text x="0" y="22" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
  _ticks(vmin, vmax, 5).forEach(v => { const py = Y(v); svg += `<line x1="${m.l}" y1="${py.toFixed(1)}" x2="${m.l + pw}" y2="${py.toFixed(1)}" stroke="${pal.grid}" stroke-width="1"/><text x="${m.l - 7}" y="${(py + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${pal.faint}">${_fmt(v)}</text>`; });
  const zy = Y(0);
  data.forEach((d, i) => {
    const cx = m.l + slot * i + slot / 2, col = d.color || pal.series[i % pal.series.length];
    const y0 = Math.min(zy, Y(d.value)), bh = Math.abs(Y(d.value) - zy);
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="4" fill="${col}"/>`;
    svg += `<text x="${cx.toFixed(1)}" y="${(Y(d.value) + (d.value < 0 ? 14 : -6)).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${pal.soft}">${_fmt(d.value)}</text>`;
    _wrap(d.label, Math.max(5, Math.floor(slot / 6.4))).slice(0, 2).forEach((ln, li) => { svg += `<text x="${cx.toFixed(1)}" y="${m.t + ph + 16 + li * 13}" text-anchor="middle" font-size="11.5" fill="${pal.ink}">${_esc(ln)}</text>`; });
  });
  svg += `<line x1="${m.l}" y1="${zy.toFixed(1)}" x2="${m.l + pw}" y2="${zy.toFixed(1)}" stroke="${pal.frame}" stroke-width="1.5"/>`;
  if (spec.yLabel) svg += `<text x="14" y="${m.t + ph / 2}" text-anchor="middle" font-size="12" fill="${pal.soft}" transform="rotate(-90 14 ${m.t + ph / 2})">${_esc(spec.yLabel)}</text>`;
  svg += `</svg>`; return svg;
}

/* ---------------- TABLE — tableau ---------------- */
function figTable(spec, pal) {
  const cols = Array.isArray(spec.columns) ? spec.columns.map(c => String(c == null ? "" : c)) : null;
  const rows = Array.isArray(spec.rows) ? spec.rows.map(r => Array.isArray(r) ? r.map(c => String(c == null ? "" : c)) : [String(r == null ? "" : r)]) : [];
  const ncol = cols ? cols.length : (rows[0] ? rows[0].length : 1);
  if (!ncol) return null;
  const W = 620, pad = 11, fs = 13.5, lh = 18, titleH = spec.titre ? 32 : 4;
  const charw = [];
  for (let c = 0; c < ncol; c++) { let mx = cols ? cols[c].length : 1; rows.forEach(r => { mx = Math.max(mx, (r[c] || "").length); }); charw.push(Math.max(3, mx)); }
  const tot = charw.reduce((a, b) => a + b, 0) || 1;
  const colW = charw.map(c => Math.max(50, Math.round(c / tot * W)));
  let sum = colW.reduce((a, b) => a + b, 0); const fix = Math.round((W - sum) / ncol);
  for (let c = 0; c < ncol; c++) colW[c] += fix;
  colW[ncol - 1] += W - colW.reduce((a, b) => a + b, 0);
  const colX = [0]; for (let c = 0; c < ncol; c++) colX.push(colX[c] + colW[c]);
  const maxcOf = w => Math.max(3, Math.floor((w - pad * 2) / (fs * 0.55)));
  const linesFor = r => { let h = 1; const cells = []; for (let c = 0; c < ncol; c++) { const ls = _wrap(r[c] || "", maxcOf(colW[c])); cells.push(ls); h = Math.max(h, ls.length); } return { cells, h }; };
  const head = cols ? linesFor(cols) : null;
  const body = rows.map(linesFor);
  const rh = o => o.h * lh + pad * 2;
  const headH = head ? rh(head) : 0;
  const H = titleH + headH + body.reduce((a, r) => a + rh(r), 0) + 2;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
  if (spec.titre) svg += `<text x="0" y="21" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
  let y = titleH;
  if (head) {
    svg += `<rect x="0" y="${y}" width="${W}" height="${headH}" fill="${pal.headBg}"/>`;
    cols.forEach((c, ci) => head.cells[ci].forEach((ln, li) => { svg += `<text x="${colX[ci] + pad}" y="${y + pad + 13 + li * lh}" font-size="${fs}" font-weight="600" fill="${pal.headInk}">${_esc(ln)}</text>`; }));
    y += headH;
  }
  body.forEach((r, ri) => {
    const h = rh(r);
    if (ri % 2 === 1) svg += `<rect x="0" y="${y}" width="${W}" height="${h}" fill="${pal.zebra}"/>`;
    for (let c = 0; c < ncol; c++) r.cells[c].forEach((ln, li) => { const bold = c === 0 && ncol > 1; svg += `<text x="${colX[c] + pad}" y="${y + pad + 13 + li * lh}" font-size="${fs}"${bold ? ` font-weight="600"` : ""} fill="${bold ? pal.ink : pal.soft}">${_esc(ln)}</text>`; });
    if (ri) svg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${pal.grid}" stroke-width="1"/>`;
    y += h;
  });
  for (let c = 1; c < ncol; c++) svg += `<line x1="${colX[c]}" y1="${titleH}" x2="${colX[c]}" y2="${H}" stroke="${pal.grid}" stroke-width="1"/>`;
  svg += `<rect x="0.5" y="${titleH + 0.5}" width="${W - 1}" height="${(H - titleH - 1).toFixed(1)}" fill="none" stroke="${pal.frame}" stroke-width="1.5" rx="2"/>`;
  svg += `</svg>`; return svg;
}

/* ---------------- TREE — arbre / hiérarchie ---------------- */
function figTree(spec, pal) {
  const root = spec.root || spec.node || { label: spec.titre || "Racine", children: spec.children };
  let leaf = 0; const all = [];
  function rec(n, d) {
    const node = { label: String(n && n.label != null ? n.label : ""), d, kids: [] };
    const ch = n && Array.isArray(n.children) ? n.children : [];
    if (!ch.length) node.x = leaf++;
    else { node.kids = ch.map(c => rec(c, d + 1)); node.x = (node.kids[0].x + node.kids[node.kids.length - 1].x) / 2; }
    all.push(node); return node;
  }
  rec(root, 0);
  const leaves = Math.max(1, leaf); let maxD = 0; all.forEach(n => { if (n.d > maxD) maxD = n.d; });
  const fs = 12.5, levelH = 70, boxH = 36;
  const colW = Math.min(150, Math.max(66, Math.floor(1000 / leaves)));
  const totW = Math.max(560, leaves * colW), pad = 14;
  const H = (spec.titre ? 30 : 8) + maxD * levelH + boxH + 18;
  const topY = spec.titre ? 30 : 8;
  const X = x => leaves <= 1 ? totW / 2 : pad + colW / 2 + (x / (leaves - 1)) * (totW - pad * 2 - colW);
  const Y = d => topY + d * levelH;
  let svg = `<svg viewBox="0 0 ${totW} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
  if (spec.titre) svg += `<text x="${pad}" y="21" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
  all.forEach(n => n.kids.forEach(k => { const x1 = X(n.x), y1 = Y(n.d) + boxH, x2 = X(k.x), y2 = Y(k.d), my = (y1 + y2) / 2; svg += `<path d="M${x1.toFixed(1)} ${y1} C ${x1.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2}" fill="none" stroke="${pal.frame}" stroke-width="1.5"/>`; }));
  all.forEach(n => {
    const cx = X(n.x), y = Y(n.d), col = pal.series[n.d % pal.series.length];
    const lines = _wrap(n.label, Math.max(6, Math.floor((colW - 14) / (fs * 0.55)))).slice(0, 3);
    const bw = Math.min(colW - 16, Math.max(48, _maxLen(lines) * fs * 0.56 + 20));
    const bh = Math.max(boxH, lines.length * 15 + 14);
    const root0 = n.d === 0, fill = root0 ? col : pal.surface, tcol = root0 ? "#fff" : pal.ink;
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" rx="9" fill="${fill}" stroke="${col}" stroke-width="1.6"/>`;
    if (!root0) svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y}" width="4" height="${bh}" rx="2" fill="${col}"/>`;
    lines.forEach((ln, li) => { svg += `<text x="${cx.toFixed(1)}" y="${(y + bh / 2 - (lines.length - 1) * 7.5 + li * 15 + 4).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-weight="${root0 ? 600 : 400}" fill="${tcol}">${_esc(ln)}</text>`; });
  });
  svg += `</svg>`; return svg;
}

/* ---------------- TIMELINE — frise chronologique (verticale) ---------------- */
function figTimeline(spec, pal) {
  const ev = Array.isArray(spec.events) ? spec.events : [];
  if (!ev.length) return null;
  const W = 620, titleH = spec.titre ? 32 : 8, leftW = 92, spineX = leftW + 10, textX = spineX + 22, pad = 5, lh = 18, fs = 13.5, gap = 14;
  const maxc = Math.max(12, Math.floor((W - textX - 12) / (fs * 0.55)));
  const items = ev.map(e => { const lines = _wrap(String(e && e.label != null ? e.label : ""), maxc); return { date: String(e && e.date != null ? e.date : ""), lines, h: Math.max(lines.length * lh + pad * 2, 32) }; });
  const total = items.reduce((a, i) => a + i.h + gap, 0) - gap;
  const H = titleH + total + 8;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
  if (spec.titre) svg += `<text x="0" y="21" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
  svg += `<line x1="${spineX}" y1="${titleH + 8}" x2="${spineX}" y2="${titleH + total - items[items.length - 1].h + 16}" stroke="${pal.frame}" stroke-width="2"/>`;
  let y = titleH;
  items.forEach((it, idx) => {
    const cy = y + 16, col = pal.series[idx % pal.series.length];
    svg += `<circle cx="${spineX}" cy="${cy}" r="6" fill="${col}" stroke="${pal.surface}" stroke-width="2.5"/>`;
    if (it.date) svg += `<text x="${leftW}" y="${cy + 4}" text-anchor="end" font-size="12.5" font-weight="600" font-family="'JetBrains Mono',ui-monospace,monospace" fill="${pal.ink}">${_esc(it.date)}</text>`;
    it.lines.forEach((ln, li) => { svg += `<text x="${textX}" y="${y + pad + 13 + li * lh}" font-size="${fs}" fill="${pal.soft}">${_esc(ln)}</text>`; });
    y += it.h + gap;
  });
  svg += `</svg>`; return svg;
}

/* ---------------- GRAPH — réseau / graphe de nœuds reliés (villes, états, réseau) ---------------- */
function figGraph(spec, pal) {
  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  if (!rawNodes.length) return null;
  const nodes = rawNodes.map((n, i) => {
    if (n && typeof n === "object") return { id: String(n.id != null ? n.id : (n.label != null ? n.label : i)), label: String(n.label != null ? n.label : (n.id != null ? n.id : i)), x: typeof n.x === "number" ? n.x : null, y: typeof n.y === "number" ? n.y : null };
    return { id: String(n), label: String(n), x: null, y: null };
  });
  const pos = {}; nodes.forEach(n => { pos[n.id] = n; });
  const edges = (Array.isArray(spec.edges) ? spec.edges : []).map(e => ({ from: String(e && e.from), to: String(e && e.to), label: e && e.label != null ? String(e.label) : "" })).filter(e => pos[e.from] && pos[e.to]);
  const directed = !!spec.directed;
  const hasPos = nodes.every(n => n.x != null && n.y != null);
  if (!hasPos) { const N = nodes.length; nodes.forEach((n, i) => { const a = -Math.PI / 2 + i / N * 2 * Math.PI; n.x = 50 + 42 * Math.cos(a); n.y = 50 + 42 * Math.sin(a); }); }
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < 1e-6) maxX = minX + 1;
  if (maxY - minY < 1e-6) maxY = minY + 1;
  const W = 620, titleH = spec.titre ? 30 : 10, padX = 66, padTop = titleH + 16, padBot = 16;
  const innerW = W - padX * 2, aspect = (maxY - minY) / (maxX - minX);
  const innerH = Math.max(170, Math.min(480, innerW * aspect));
  const H = padTop + innerH + padBot;
  const X = x => padX + (x - minX) / (maxX - minX) * innerW;
  const Y = y => padTop + (y - minY) / (maxY - minY) * innerH;
  const fs = 12, ew = 11;
  let svg = `<svg viewBox="0 0 ${W} ${H.toFixed(0)}" xmlns="http://www.w3.org/2000/svg" font-family="'IBM Plex Sans',system-ui,sans-serif">`;
  if (directed) svg += `<defs><marker id="garr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="${pal.soft}"/></marker></defs>`;
  if (spec.titre) svg += `<text x="0" y="20" font-size="15" font-weight="600" fill="${pal.ink}">${_esc(spec.titre)}</text>`;
  edges.forEach(e => {
    const a = pos[e.from], b = pos[e.to];
    let x1 = X(a.x), y1 = Y(a.y), x2 = X(b.x), y2 = Y(b.y);
    if (directed) { const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, off = 18; x2 -= dx / len * off; y2 -= dy / len * off; }
    svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${pal.frame}" stroke-width="1.5"${directed ? ` marker-end="url(#garr)"` : ""}/>`;
    if (e.label) { const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, w = e.label.length * ew * 0.62 + 9; svg += `<rect x="${(mx - w / 2).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="${w.toFixed(1)}" height="16" rx="4" fill="${pal.surface}" stroke="${pal.grid}" stroke-width="1"/><text x="${mx.toFixed(1)}" y="${(my + 3).toFixed(1)}" text-anchor="middle" font-size="${ew}" font-weight="600" fill="${pal.soft}">${_esc(e.label)}</text>`; }
  });
  nodes.forEach(n => {
    const px = X(n.x), py = Y(n.y), col = pal.series[0];
    const bw = Math.max(30, n.label.length * fs * 0.56 + 16), bh = 23;
    svg += `<rect x="${(px - bw / 2).toFixed(1)}" y="${(py - bh / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="${bh / 2}" fill="${pal.surface}" stroke="${col}" stroke-width="1.6"/>`;
    svg += `<text x="${px.toFixed(1)}" y="${(py + 4).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-weight="500" fill="${pal.ink}">${_esc(n.label)}</text>`;
  });
  svg += `</svg>`; return svg;
}

function buildFigureSVG(spec, pal) {
  pal = pal || APP_FIG_PALETTE;
  try {
    if (!spec || typeof spec !== "object") return null;
    const t = (spec.type || "").toLowerCase();
    if (t === "bars" || t === "bar" || t === "histogramme") return figBars(spec, pal);
    if (t === "table" || t === "tableau") return figTable(spec, pal);
    if (t === "tree" || t === "arbre") return figTree(spec, pal);
    if (t === "timeline" || t === "frise") return figTimeline(spec, pal);
    if (t === "graph" || t === "graphe" || t === "network" || t === "reseau" || t === "réseau") return figGraph(spec, pal);
    if (Array.isArray(spec.edges) && Array.isArray(spec.nodes)) return figGraph(spec, pal);
    if (t === "flow" || (Array.isArray(spec.nodes) && !spec.series)) return figFlow(spec, pal);
    if (Array.isArray(spec.columns) || Array.isArray(spec.rows)) return figTable(spec, pal);
    if (spec.root || (Array.isArray(spec.children) && !spec.series)) return figTree(spec, pal);
    if (Array.isArray(spec.events)) return figTimeline(spec, pal);
    if (Array.isArray(spec.data) && spec.data[0] && spec.data[0].value != null && !spec.series) return figBars(spec, pal);
    return figPlot(spec, pal);
  } catch (e) { return null; }
}

/* React component used inside the lesson prose */
function FigureBlock({ src }) {
  let spec = null;
  try { spec = JSON.parse(src.trim()); } catch (e) { try { spec = window.parseJSON(src); } catch (_) {} }
  const svg = spec ? buildFigureSVG(spec, APP_FIG_PALETTE) : null;
  if (!svg) return <div className="figure figure-fallback"><span className="muted mono" style={{ fontSize: 12 }}>schéma non disponible</span></div>;
  return <div className="figure" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/* ---- registry of ORIGINAL course images, keyed by short id (e.g. "f3") ---- */
const HML_FIGS = (window.HML_FIGS = window.HML_FIGS || {});
function registerFigImage(id, url) { if (id && url) HML_FIGS[id] = url; }

/* parse the body of an ```img``` fence or a [img:fN] line → { id, caption } */
function parseImgRef(body) {
  const raw = String(body || "").trim();
  if (raw.startsWith("{")) { try { const o = JSON.parse(raw); return { id: String(o.id || "").trim(), caption: o.caption || "" }; } catch (e) {} }
  const m = raw.match(/(f\d+)/i);
  const id = m ? m[1] : raw.split(/\s+/)[0];
  const caption = raw.replace(/\[?img:?/i, "").replace(/\]/g, "").replace(id, "").trim();
  return { id, caption };
}

/* React component: re-inserts an ORIGINAL figure extracted from the course */
function ImageBlock({ id, caption }) {
  const src = HML_FIGS[id];
  if (!src) return <div className="figure figure-fallback"><span className="muted mono" style={{ fontSize: 12 }}>figure du cours indisponible</span></div>;
  return (
    <figure className="figure course-fig" style={{ textAlign: "center" }}>
      <img src={src} alt={caption || "Figure du cours"} loading="lazy" style={{ maxWidth: "100%", maxHeight: 460, borderRadius: 7, display: "block", margin: "0 auto" }} />
      <figcaption className="muted" style={{ fontSize: 12, marginTop: 7, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--accent-deep)" }}>Figure du cours</span>
        {caption && <span>· {caption}</span>}
      </figcaption>
    </figure>
  );
}

Object.assign(window, { compileExpr, buildFigureSVG, FigureBlock, ImageBlock, registerFigImage, parseImgRef, APP_FIG_PALETTE, EXPORT_FIG_PALETTE });