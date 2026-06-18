/* ============================================================
   lib/speech.jsx — read-aloud (Web Speech API, zero dependency)
   Phase 1 of the voice features: text-to-speech with synced
   block highlighting, speed + voice controls, and a clickable
   table of contents. Built to host Phase 2 (Gemini Live voice
   Q&A) later without rework.
   ============================================================ */
const { useState, useEffect, useRef } = React;
const SpIcon = window.Icon;

/* i18n with a French fallback: uses window.ui(key) when the key is translated,
   otherwise the literal fallback — so nothing breaks before keys are added. */
const T = (key, fallback) => { const v = window.ui ? window.ui(key) : null; return (v && v !== key) ? v : fallback; };

/* app UI lang codes -> BCP-47, for voice selection */
const LANG_BCP47 = { fr: "fr-FR", en: "en-US", de: "de-DE", es: "es-ES", it: "it-IT", pt: "pt-PT", mx: "de-DE" };
const RATES = [1, 1.25, 1.5, 0.75];

function speechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

function getRecognitionCtor() {
  return (typeof window !== "undefined") && (window.SpeechRecognition || window.webkitSpeechRecognition) || null;
}
function recognitionSupported() { return !!getRecognitionCtor(); }

/* strip light markdown so the TTS reads prose, not symbols */
function plainForSpeech(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* voices load asynchronously on Chrome — keep them fresh */
function useVoices() {
  const [voices, setVoices] = useState(() => speechSupported() ? window.speechSynthesis.getVoices() : []);
  useEffect(() => {
    if (!speechSupported()) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  return voices;
}

function pickDefaultVoice(voices, bcp47) {
  if (!voices || !voices.length) return null;
  const base = (bcp47 || "fr-FR").slice(0, 2).toLowerCase();
  return voices.find(v => v.lang === bcp47)
      || voices.find(v => v.lang && v.lang.toLowerCase().startsWith(base))
      || voices.find(v => v.default)
      || voices[0];
}

/* split a block into short, speakable sentences (short utterances dodge
   Chrome's long-utterance cutoff and keep highlighting granular) */
function splitSentences(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?…]+[.!?…]+(?:\s|$)|[^.!?…]+$/g) || [clean];
  return parts.map(s => s.trim()).filter(Boolean);
}

/* ---- multilingual reading ----
   The lesson prose is in the output language (e.g. French) but carries German
   technical terms. A French voice butchers them, so we read those terms with a
   German voice. The reliable "this word is German" signal is the chapter
   glossary (termes[].de), not the <<term>> markup (which marks key concepts in
   any language). We build a matcher from the glossary and split each sentence
   into language-tagged segments. */
function buildGermanMatcher(terms) {
  const cleaned = (terms || [])
    .map(t => (t || "").trim())
    .filter(t => t.length >= 4)
    .sort((a, b) => b.length - a.length)   // longest first so multi-word terms win
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!cleaned.length) return null;
  try {
    return new RegExp("(?<![\\p{L}])(" + cleaned.join("|") + ")(?![\\p{L}])", "giu");
  } catch (_) {
    try { return new RegExp("\\b(" + cleaned.join("|") + ")\\b", "gi"); } catch (_) { return null; }
  }
}
function segmentByLang(text, matcher, mainLang) {
  if (!matcher) return [{ text, lang: mainLang }];
  const raw = [];
  let last = 0, m;
  matcher.lastIndex = 0;
  while ((m = matcher.exec(text)) !== null) {
    if (m.index > last) raw.push({ text: text.slice(last, m.index), lang: mainLang });
    raw.push({ text: m[0], lang: "de" });
    last = m.index + m[0].length;
    if (m.index === matcher.lastIndex) matcher.lastIndex++;
  }
  if (last < text.length) raw.push({ text: text.slice(last), lang: mainLang });
  // merge adjacent same-language segments; attach whitespace-only bits to the previous
  const out = [];
  for (const s of raw) {
    if (!s.text) continue;
    if (!s.text.trim() && out.length) { out[out.length - 1].text += s.text; continue; }
    if (out.length && out[out.length - 1].lang === s.lang) out[out.length - 1].text += s.text;
    else out.push({ text: s.text, lang: s.lang });
  }
  return out.length ? out : [{ text, lang: mainLang }];
}

/* build the ordered reading queue from the rendered lesson DOM.
   item = { node, text, lang, sectionN } — read each section's title then its
   readable blocks, sentence by sentence (split into language segments),
   highlighting the live node. */
function buildQueue(rootSelector, opts) {
  opts = opts || {};
  const mainLang = opts.mainLang || "fr";
  const matcher = (mainLang === "de") ? null : (opts.matcher || null);   // no point if the lesson IS German
  const root = document.querySelector(rootSelector);
  if (!root) return [];
  const items = [];
  const pushText = (node, txt, n) => {
    splitSentences(txt).forEach(s => {
      segmentByLang(s, matcher, mainLang).forEach(seg => {
        if (seg.text.trim()) items.push({ node, text: seg.text, lang: seg.lang, sectionN: n });
      });
    });
  };
  root.querySelectorAll(".section-card").forEach(card => {
    const n = card.getAttribute("data-section-n");
    const title = card.querySelector("h3");
    if (title && title.textContent.trim()) pushText(title, title.textContent, n);
    card.querySelectorAll(".prose > p, .prose > h4, .prose li, .complement, .insertion-card").forEach(b => {
      const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (txt) pushText(b, txt, n);
    });
  });
  return items;
}

/* Imperative engine, decoupled from React to avoid stale closures.
   onState({ status?, caption?, section? }) pushes updates to the bar. */
class LessonReader {
  constructor(onState) {
    this.onState = onState;
    this.queue = []; this.idx = 0; this.playing = false;
    this.lastNode = null; this.current = null;
    this.rate = 1; this.voice = null; this.bcp47 = "fr-FR";
    this.voices = []; this.mainLang = "fr"; this.germanMatcher = null; this._voiceCache = {};
    this.root = ".content-inner";
    // smart auto-follow: record genuine user scroll intent so we never fight it
    this.follow = true;           // auto-follow the reading position
    this._scrollBound = false;
    // a genuine user scroll (wheel/touch/keys — NOT programmatic scrollIntoView)
    // hands control back to the user: stop following, but keep the highlight.
    this._scrollHandler = () => {
      if (this.follow) { this.follow = false; this.onState({ follow: false }); }
    };
  }
  _bindScroll() {
    if (this._scrollBound) return;
    ["wheel", "touchmove", "keydown"].forEach(ev => window.addEventListener(ev, this._scrollHandler, { passive: true }));
    this._scrollBound = true;
  }
  _unbindScroll() {
    if (!this._scrollBound) return;
    ["wheel", "touchmove", "keydown"].forEach(ev => window.removeEventListener(ev, this._scrollHandler));
    this._scrollBound = false;
  }
  setVoice(v) { this.voice = v; }
  setRate(r) { this.rate = r; }
  setLang(b) { this.bcp47 = b; }
  setVoices(list) { this.voices = list || []; this._voiceCache = {}; }
  setMainLang(code) { this.mainLang = code || "fr"; }
  setGermanTerms(terms) { try { this.germanMatcher = buildGermanMatcher(terms); } catch (_) { this.germanMatcher = null; } }
  _voiceFor(lang) {
    if (!lang || lang === this.mainLang) return this.voice;
    if (this._voiceCache[lang] !== undefined) return this._voiceCache[lang];
    const v = pickDefaultVoice(this.voices, LANG_BCP47[lang] || lang) || this.voice;
    this._voiceCache[lang] = v;
    return v;
  }
  /* re-speak the current sentence (used when the voice changes mid-read).
     Chrome can swallow speak() called immediately after cancel(), so we give
     the queue a beat to clear before re-speaking. */
  restartCurrent() {
    if (!this.playing || this.aside) return;
    this.current = null;
    try { window.speechSynthesis.cancel(); } catch (_) {}
    setTimeout(() => { if (this.playing && !this.aside) this._speakCurrent(); }, 70);
  }
  _clear() {
    if (this.lastNode) this.lastNode.classList.remove("reading-now");
    this.lastNode = null;
    document.querySelectorAll(".reading-section").forEach(el => el.classList.remove("reading-section"));
  }
  _highlight(node, sectionN) {
    if (this.lastNode === node) return;
    if (this.lastNode) this.lastNode.classList.remove("reading-now");
    node.classList.add("reading-now");
    this.lastNode = node;
    document.querySelectorAll(".reading-section").forEach(el => el.classList.remove("reading-section"));
    const card = node.closest(".section-card");
    if (card) card.classList.add("reading-section");
    // only the reader follows; the moment the user scrolls, follow is off and
    // we never yank them back (the highlight stays so they can find it again)
    if (this.follow) {
      const r = node.getBoundingClientRect();
      if (r.top < 90 || r.bottom > window.innerHeight - 140) {
        node.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
  /* re-enable follow and jump back to where the voice is reading */
  enableFollow() {
    this.follow = true;
    this.onState({ follow: true });
    if (this.lastNode) this.lastNode.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  _speakCurrent() {
    if (!this.playing) return;
    if (this.idx >= this.queue.length) { this.stop(); return; }
    const item = this.queue[this.idx];
    if (item.node && document.contains(item.node)) this._highlight(item.node, item.sectionN);
    this.onState({ caption: item.text, section: item.sectionN });
    const u = new SpeechSynthesisUtterance(item.text);
    const v = this._voiceFor(item.lang || this.mainLang);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || LANG_BCP47[item.lang] || this.bcp47;
    u.rate = this.rate;
    const advance = () => {
      if (this.current !== u || !this.playing) return;   // ignore stale/cancelled utterances
      this.idx++; this._speakCurrent();
    };
    u.onend = advance;
    u.onerror = advance;
    this.current = u;
    window.speechSynthesis.speak(u);
  }
  start(sectionN) {
    window.speechSynthesis.cancel();
    this.queue = buildQueue(this.root, { matcher: this.germanMatcher, mainLang: this.mainLang });
    let start = 0;
    if (sectionN != null) {
      const fi = this.queue.findIndex(it => String(it.sectionN) === String(sectionN));
      if (fi >= 0) start = fi;
    }
    this.idx = start; this.playing = true; this.follow = true;
    this._bindScroll();
    this.onState({ status: "playing", follow: true });
    this._speakCurrent();
  }
  resume() { window.speechSynthesis.resume(); this.playing = true; this._bindScroll(); this.onState({ status: "playing" }); }
  pause() { window.speechSynthesis.pause(); this.playing = false; this.onState({ status: "paused" }); }
  stop() {
    this.playing = false; this.current = null;
    this._unbindScroll();
    try { window.speechSynthesis.cancel(); } catch (_) {}
    this._clear();
    this.onState({ status: "idle", caption: "", section: null });
  }
  skipSection(dir) {
    if (!this.queue.length) this.queue = buildQueue(this.root);
    const sections = [...new Set(this.queue.map(it => String(it.sectionN)))];
    const cur = this.queue[this.idx] ? String(this.queue[this.idx].sectionN) : sections[0];
    let pos = sections.indexOf(cur); if (pos < 0) pos = 0;
    const target = sections[Math.max(0, Math.min(sections.length - 1, pos + dir))];
    window.speechSynthesis.cancel();
    const fi = this.queue.findIndex(it => String(it.sectionN) === target);
    this.idx = fi >= 0 ? fi : 0; this.playing = true;
    this.onState({ status: "playing" });
    this._speakCurrent();
  }
  /* speak a one-off answer (the voice Q&A), without disturbing the lesson queue */
  speakAside(text, onDone) {
    window.speechSynthesis.cancel();
    this.playing = false;
    const sentences = splitSentences(plainForSpeech(text));
    let i = 0;
    const next = () => {
      if (i >= sentences.length) { this.aside = null; if (onDone) onDone(); return; }
      const u = new SpeechSynthesisUtterance(sentences[i]);
      if (this.voice) u.voice = this.voice;
      u.lang = (this.voice && this.voice.lang) || this.bcp47;
      u.rate = this.rate;
      const adv = () => { if (this.aside !== u) return; i++; next(); };
      u.onend = adv; u.onerror = adv;
      this.aside = u;
      window.speechSynthesis.speak(u);
    };
    next();
  }
  stopAside() { this.aside = null; try { window.speechSynthesis.cancel(); } catch (_) {} }
  /* resume the lesson from where it was paused (after a Q&A aside) */
  resumeFromCurrent() {
    this.aside = null;
    try { window.speechSynthesis.cancel(); } catch (_) {}
    if (!this.queue.length) { this.start(null); return; }
    this.playing = true; this.follow = true;
    this._bindScroll();
    this.onState({ status: "playing", follow: true });
    this._speakCurrent();
  }
}

function ReadAloudBar({ chapter, lang, onClose }) {
  const voices = useVoices();
  const bcp47 = LANG_BCP47[lang] || "fr-FR";
  const [status, setStatus] = useState("idle");
  const [follow, setFollow] = useState(true);
  const [caption, setCaption] = useState("");
  const [curSection, setCurSection] = useState(null);
  const [rate, setRate] = useState(() => { const r = parseFloat(localStorage.getItem("hml.ttsRate")); return RATES.includes(r) ? r : 1; });
  const [voiceURI, setVoiceURI] = useState(() => { try { return localStorage.getItem("hml.ttsVoice") || ""; } catch (_) { return ""; } });
  const [tocOpen, setTocOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [ask, setAsk] = useState(null); // { phase:'listening'|'thinking'|'answer'|'error', question, interim, answer, source, error }
  const [barCollapsed, setBarCollapsed] = useState(false);
  const [showHint, setShowHint] = useState(() => { try { return localStorage.getItem("hml.ttsHintSeen") !== "1"; } catch (_) { return true; } });
  const engineRef = useRef(null);
  const recRef = useRef(null);

  if (!engineRef.current && speechSupported()) {
    engineRef.current = new LessonReader((p) => {
      if (p.status !== undefined) setStatus(p.status);
      if (p.follow !== undefined) setFollow(p.follow);
      if (p.caption !== undefined) setCaption(p.caption);
      if (p.section !== undefined) setCurSection(p.section);
    });
  }
  const eng = engineRef.current;

  const voice = voices.find(v => v.voiceURI === voiceURI) || pickDefaultVoice(voices, bcp47);

  useEffect(() => {
    if (!eng) return;
    eng.setVoice(voice || null);
    eng.setVoices(voices);
    eng.setRate(rate);
    eng.setLang(bcp47);
    eng.setMainLang(lang);
    eng.setGermanTerms((chapter.termes || []).map(t => t && t.de).filter(Boolean));
  }, [eng, voice, voices, rate, bcp47, lang, chapter]);
  useEffect(() => { if (!voiceURI && voices.length) { const v = pickDefaultVoice(voices, bcp47); if (v) setVoiceURI(v.voiceURI); } }, [voices, bcp47, voiceURI]);

  /* auto-start on mount; always cancel speech + recognition on unmount */
  useEffect(() => {
    if (eng) {
      eng.setVoice(voice || null); eng.setVoices(voices); eng.setRate(rate); eng.setLang(bcp47);
      eng.setMainLang(lang); eng.setGermanTerms((chapter.termes || []).map(t => t && t.de).filter(Boolean));
      eng.start(null);
    }
    return () => {
      if (eng) eng.stop();
      try { if (recRef.current) { recRef.current.onend = null; recRef.current.abort(); } } catch (_) {}
    };
  }, []); // eslint-disable-line

  // keyboard shortcut: K = play/pause (Space left free for scrolling), Esc expands a collapsed bar
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
      const en = engineRef.current; if (!en) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        if (status === "playing") en.pause(); else if (status === "paused") en.resume(); else en.start(null);
      } else if (e.key === "Escape" && barCollapsed) {
        setBarCollapsed(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [status, barCollapsed]);

  // one-time discoverability hint
  useEffect(() => {
    if (!showHint) return;
    const t = setTimeout(() => { setShowHint(false); try { localStorage.setItem("hml.ttsHintSeen", "1"); } catch (_) {} }, 9000);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line

  if (!speechSupported()) {
    return (
      <div className="read-bar">
        <span className="read-caption">La lecture vocale n'est pas supportée par ce navigateur (essaie Chrome ou Edge).</span>
        <button className="icon-btn" title="Fermer" onClick={() => onClose && onClose()}><SpIcon name="x" size={16} /></button>
      </div>
    );
  }

  const sectionList = chapter.sections.filter(s => s.status === "done");
  let voiceOptions = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith(bcp47.slice(0, 2).toLowerCase()));
  if (!voiceOptions.length) voiceOptions = voices;
  const cycleRate = () => setRate(r => { const nr = RATES[(RATES.indexOf(r) + 1) % RATES.length]; try { localStorage.setItem("hml.ttsRate", nr); } catch (_) {} return nr; });
  const togglePlay = () => {
    if (status === "playing") eng.pause();
    else if (status === "paused") eng.resume();
    else eng.start(null);
  };

  function stopRec() { try { if (recRef.current) { recRef.current.onend = null; recRef.current.stop(); } } catch (_) {} recRef.current = null; }

  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) { setAsk({ phase: "error", error: "La reconnaissance vocale n'est pas supportée par ce navigateur (essaie Chrome ou Edge)." }); return; }
    if (status === "playing") eng.pause();
    eng.stopAside();
    setAsk({ phase: "listening", interim: "" });
    const rec = new Ctor();
    rec.lang = bcp47; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      setAsk(a => (a && a.phase === "listening") ? { ...a, interim: (finalText + " " + interim).trim() } : a);
    };
    rec.onerror = (e) => {
      const msg = (e && e.error === "not-allowed") ? "Accès au micro refusé — autorise le micro dans le navigateur." : "Je n'ai pas bien entendu. Réessaie.";
      setAsk(a => (a && a.phase === "listening") ? { phase: "error", error: msg } : a);
    };
    rec.onend = () => {
      recRef.current = null;
      const q = finalText.trim();
      if (q) doAsk(q);
      else setAsk(a => (a && a.phase === "listening") ? null : a);
    };
    recRef.current = rec;
    try { rec.start(); } catch (_) {}
  }

  async function doAsk(question) {
    setAsk({ phase: "thinking", question });
    try {
      const section = chapter.sections.find(s => String(s.n) === String(curSection))
                   || chapter.sections.find(s => s.status === "done")
                   || chapter.sections[0];
      const passage = caption || (section && section.titre) || "";
      const data = window.parseJSON(await window.callClaude(window.buildAskPrompt(chapter, section, passage, question)));
      const answer = (data && data.reponse) ? data.reponse : "";
      if (!answer || answer.length < 2) { setAsk({ phase: "error", question, error: "Réponse vide du moteur." }); return; }
      setAsk({ phase: "answer", question, answer, source: data.trouveDansLeCours ? "cours" : "hors-cours" });
      eng.speakAside(answer);
    } catch (e) {
      setAsk({ phase: "error", question, error: (e && e.message) || String(e) });
    }
  }

  function closeAsk() { stopRec(); eng.stopAside(); setAsk(null); }
  function resumeReading() { stopRec(); setAsk(null); eng.resumeFromCurrent(); }

  const listening = !!(ask && ask.phase === "listening");

  return (
    <React.Fragment>
      {barCollapsed && (
        <button className="read-fab fade-in" title={T("raShow", "Afficher la lecture")} aria-label={T("raShow", "Afficher la lecture")} onClick={() => setBarCollapsed(false)}>
          <SpIcon name="speaker" size={18} />
        </button>
      )}
    <div className="read-bar" data-collapsed={barCollapsed}>
      {/* voice Q&A panel (above the bar) */}
      {ask && (
        <div className="read-ask">
          {ask.phase === "listening" && (
            <div className="read-ask-row">
              <span className="read-ask-pulse"><SpIcon name="mic" size={15} /></span>
              <span className="read-ask-live">{ask.interim || "J'écoute ta question…"}</span>
              <button className="btn btn-sm btn-ghost" onClick={closeAsk}>Annuler</button>
            </div>
          )}
          {ask.phase === "thinking" && (
            <div className="read-ask-row">
              <window.Spinner size={15} />
              <span className="read-ask-live">« {ask.question} »</span>
            </div>
          )}
          {ask.phase === "answer" && (
            <div className="read-ask-scroll">
              <div className="read-ask-q">« {ask.question} »</div>
              <span className={"tag " + (ask.source === "cours" ? "tag-good" : "tag-ochre")}>
                {ask.source === "cours" ? "D'après le cours" : "Hors cours — complément"}
              </span>
              <div className="prose" style={{ fontSize: "var(--fs-body)", marginTop: "var(--space-2)" }}>
                {window.renderMarkdown ? window.renderMarkdown(ask.answer) : ask.answer}
              </div>
              <div className="read-ask-actions">
                <button className="btn btn-sm btn-primary" onClick={resumeReading}><SpIcon name="play" size={13} /> Reprendre la lecture</button>
                <button className="btn btn-sm" onClick={startListening}><SpIcon name="mic" size={13} /> Autre question</button>
                <button className="btn btn-sm btn-ghost" onClick={closeAsk}>Fermer</button>
              </div>
            </div>
          )}
          {ask.phase === "error" && (
            <div className="read-ask-row">
              <span style={{ color: "var(--bad)", flex: 1, fontSize: "var(--fs-small)" }}>{ask.error}</span>
              <button className="btn btn-sm btn-ghost" onClick={closeAsk}>Fermer</button>
            </div>
          )}
        </div>
      )}

      {/* one-time discoverability hint */}
      {showHint && !ask && (
        <div className="read-hint">
          <span>{T("raHint", "Astuce : 🎤 pose une question à voix haute · touche K = lecture/pause")}</span>
          <button className="icon-btn" style={{ width: 26, height: 26 }} aria-label={T("raClose", "Fermer")} onClick={() => { setShowHint(false); try { localStorage.setItem("hml.ttsHintSeen", "1"); } catch (_) {} }}><SpIcon name="x" size={12} /></button>
        </div>
      )}

      {/* table of contents */}
      <div style={{ position: "relative", flex: "none" }}>
        <button className="icon-btn" title={T("raToc", "Sommaire")} aria-label={T("raToc", "Sommaire")} onClick={() => setTocOpen(o => !o)}><SpIcon name="library" size={17} /></button>
        {tocOpen && (
          <div className="read-toc">
            {sectionList.length === 0 && <div className="soft" style={{ padding: "var(--space-2) var(--space-3)", fontSize: "var(--fs-small)" }}>Aucune section prête.</div>}
            {sectionList.map(s => (
              <button key={s.n} data-cur={String(curSection) === String(s.n)} onClick={() => { setTocOpen(false); eng.start(s.n); }}>
                <span className="mono" style={{ color: "var(--ink-faint)", marginRight: 6 }}>{s.n}.</span>{s.titre || ("Section " + s.n)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* transport */}
      <button className="icon-btn" title="Section précédente" aria-label="Section précédente" onClick={() => eng.skipSection(-1)}>
        <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><SpIcon name="arrow" size={16} /></span>
      </button>
      <button className="read-play" title={status === "playing" ? "Pause" : "Lire"} aria-label={status === "playing" ? "Pause" : "Lire"} onClick={togglePlay}>
        <SpIcon name={status === "playing" ? "pause" : "play"} size={18} />
      </button>
      <button className="icon-btn" title="Section suivante" aria-label="Section suivante" onClick={() => eng.skipSection(1)}><SpIcon name="arrow" size={16} /></button>

      {/* ask by voice */}
      <button className="icon-btn read-mic" data-on={listening} title="Poser une question à voix haute" aria-label="Poser une question à voix haute" onClick={() => ask ? closeAsk() : startListening()}>
        <SpIcon name="mic" size={17} />
      </button>

      {/* return to the reading position (only when the user has scrolled away) */}
      {!follow && status !== "idle" && (
        <button className="icon-btn read-follow" title="Revenir à la lecture en cours" aria-label="Revenir à la lecture en cours" onClick={() => eng.enableFollow()}>
          <SpIcon name="target" size={16} />
        </button>
      )}

      {/* live caption */}
      <div className="read-caption" title={caption}>{caption || (status === "idle" ? "Prêt à lire" : "…")}</div>

      {/* speed + voice tucked into an overflow menu to keep the bar uncluttered */}
      <div style={{ position: "relative", flex: "none" }}>
        <button className="icon-btn" title={T("raOptions", "Options de lecture")} aria-label={T("raOptions", "Options de lecture")} onClick={() => setMoreOpen(o => !o)}><SpIcon name="menu" size={16} /></button>
        {moreOpen && (
          <div className="read-more">
            <div className="read-more-row">
              <span className="read-more-label">{T("raSpeed", "Vitesse")}</span>
              <button className="btn btn-sm read-rate" onClick={cycleRate}>{rate}×</button>
            </div>
            <div className="read-more-row">
              <span className="read-more-label">{T("raVoice", "Voix")}</span>
              <select className="read-voice" value={voiceURI}
                onChange={e => { const uri = e.target.value; setVoiceURI(uri); try { localStorage.setItem("hml.ttsVoice", uri); } catch (_) {} const v = voices.find(x => x.voiceURI === uri) || null; if (eng) { eng.setVoice(v); eng.restartCurrent(); } }}
                aria-label={T("raVoice", "Voix")}>
                {voiceOptions.map(v => <option key={v.voiceURI} value={v.voiceURI}>{(v.lang ? v.lang.slice(0, 2).toUpperCase() + " · " : "") + v.name.replace(/\s*\(.*\)\s*/g, "").slice(0, 26)}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* minimize (keeps reading, hides the bar) + close (stops) */}
      <button className="icon-btn" title="Réduire la barre" aria-label="Réduire la barre" onClick={() => setBarCollapsed(true)}><SpIcon name="chevrondown" size={16} /></button>
      <button className="icon-btn" title="Fermer" aria-label="Fermer la lecture" onClick={() => { eng.stop(); onClose && onClose(); }}><SpIcon name="x" size={16} /></button>
    </div>
    </React.Fragment>
  );
}

Object.assign(window, { ReadAloudBar, speechSupported });
