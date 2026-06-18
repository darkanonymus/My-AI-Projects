/* ============================================================
   lib/speech.jsx — read-aloud (Web Speech API, zero dependency)
   Phase 1 of the voice features: text-to-speech with synced
   block highlighting, speed + voice controls, and a clickable
   table of contents. Built to host Phase 2 (Gemini Live voice
   Q&A) later without rework.
   ============================================================ */
const { useState, useEffect, useRef } = React;
const SpIcon = window.Icon;

/* app UI lang codes -> BCP-47, for voice selection */
const LANG_BCP47 = { fr: "fr-FR", en: "en-US", de: "de-DE", es: "es-ES", it: "it-IT", pt: "pt-PT", mx: "de-DE" };
const RATES = [1, 1.25, 1.5, 0.75];

function speechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
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

/* build the ordered reading queue from the rendered lesson DOM.
   item = { node, text, sectionN } — we read each section's title then its
   readable blocks, sentence by sentence, highlighting the live node. */
function buildQueue(rootSelector) {
  const root = document.querySelector(rootSelector);
  if (!root) return [];
  const items = [];
  root.querySelectorAll(".section-card").forEach(card => {
    const n = card.getAttribute("data-section-n");
    const title = card.querySelector("h3");
    if (title && title.textContent.trim()) {
      splitSentences(title.textContent).forEach(s => items.push({ node: title, text: s, sectionN: n }));
    }
    card.querySelectorAll(".prose > p, .prose > h4, .prose li, .complement, .insertion-card").forEach(b => {
      const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt) return;
      splitSentences(txt).forEach(s => items.push({ node: b, text: s, sectionN: n }));
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
    this.root = ".content-inner";
  }
  setVoice(v) { this.voice = v; }
  setRate(r) { this.rate = r; }
  setLang(b) { this.bcp47 = b; }
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
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  _speakCurrent() {
    if (!this.playing) return;
    if (this.idx >= this.queue.length) { this.stop(); return; }
    const item = this.queue[this.idx];
    if (item.node && document.contains(item.node)) this._highlight(item.node, item.sectionN);
    this.onState({ caption: item.text, section: item.sectionN });
    const u = new SpeechSynthesisUtterance(item.text);
    if (this.voice) u.voice = this.voice;
    u.lang = (this.voice && this.voice.lang) || this.bcp47;
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
    this.queue = buildQueue(this.root);
    let start = 0;
    if (sectionN != null) {
      const fi = this.queue.findIndex(it => String(it.sectionN) === String(sectionN));
      if (fi >= 0) start = fi;
    }
    this.idx = start; this.playing = true;
    this.onState({ status: "playing" });
    this._speakCurrent();
  }
  resume() { window.speechSynthesis.resume(); this.playing = true; this.onState({ status: "playing" }); }
  pause() { window.speechSynthesis.pause(); this.playing = false; this.onState({ status: "paused" }); }
  stop() {
    this.playing = false; this.current = null;
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
}

function ReadAloudBar({ chapter, lang, onClose }) {
  const voices = useVoices();
  const bcp47 = LANG_BCP47[lang] || "fr-FR";
  const [status, setStatus] = useState("idle");
  const [caption, setCaption] = useState("");
  const [curSection, setCurSection] = useState(null);
  const [rate, setRate] = useState(1);
  const [voiceURI, setVoiceURI] = useState("");
  const [tocOpen, setTocOpen] = useState(false);
  const engineRef = useRef(null);

  if (!engineRef.current && speechSupported()) {
    engineRef.current = new LessonReader((p) => {
      if (p.status !== undefined) setStatus(p.status);
      if (p.caption !== undefined) setCaption(p.caption);
      if (p.section !== undefined) setCurSection(p.section);
    });
  }
  const eng = engineRef.current;

  const voice = voices.find(v => v.voiceURI === voiceURI) || pickDefaultVoice(voices, bcp47);

  useEffect(() => { if (eng) { eng.setVoice(voice || null); eng.setRate(rate); eng.setLang(bcp47); } }, [eng, voice, rate, bcp47]);
  useEffect(() => { if (!voiceURI && voices.length) { const v = pickDefaultVoice(voices, bcp47); if (v) setVoiceURI(v.voiceURI); } }, [voices, bcp47, voiceURI]);

  /* auto-start on mount; always cancel speech on unmount */
  useEffect(() => {
    if (eng) { eng.setVoice(voice || null); eng.setRate(rate); eng.setLang(bcp47); eng.start(null); }
    return () => { if (eng) eng.stop(); };
  }, []); // eslint-disable-line

  if (!speechSupported()) {
    return (
      <div className="read-bar fade-in">
        <span className="read-caption">La lecture vocale n'est pas supportée par ce navigateur (essaie Chrome ou Edge).</span>
        <button className="icon-btn" title="Fermer" onClick={() => onClose && onClose()}><SpIcon name="x" size={16} /></button>
      </div>
    );
  }

  const sectionList = chapter.sections.filter(s => s.status === "done");
  let voiceOptions = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith(bcp47.slice(0, 2).toLowerCase()));
  if (!voiceOptions.length) voiceOptions = voices;
  const cycleRate = () => setRate(r => RATES[(RATES.indexOf(r) + 1) % RATES.length]);
  const togglePlay = () => {
    if (status === "playing") eng.pause();
    else if (status === "paused") eng.resume();
    else eng.start(null);
  };

  return (
    <div className="read-bar fade-in">
      {/* table of contents */}
      <div style={{ position: "relative", flex: "none" }}>
        <button className="icon-btn" title="Sommaire" aria-label="Sommaire" onClick={() => setTocOpen(o => !o)}><SpIcon name="library" size={17} /></button>
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

      {/* live caption */}
      <div className="read-caption" title={caption}>{caption || (status === "idle" ? "Prêt à lire" : "…")}</div>

      {/* speed */}
      <button className="icon-btn read-rate" title="Vitesse de lecture" onClick={cycleRate}>{rate}×</button>

      {/* voice */}
      <select className="read-voice" value={voiceURI} onChange={e => setVoiceURI(e.target.value)} title="Voix" aria-label="Voix">
        {voiceOptions.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name.replace(/\s*\(.*\)\s*/g, "").slice(0, 20)}</option>)}
      </select>

      {/* close */}
      <button className="icon-btn" title="Fermer" aria-label="Fermer la lecture" onClick={() => { eng.stop(); onClose && onClose(); }}><SpIcon name="x" size={16} /></button>
    </div>
  );
}

Object.assign(window, { ReadAloudBar, speechSupported });
