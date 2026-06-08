/* ============================================================
   prompts.jsx — LLM prompt templates
   One builder per generation step: intro/glossary, lesson section,
   exercises (list + one-by-one), quiz, flashcards, closing —
   plus the small shared helpers they all lean on (sourceBlock,
   figuresInventory, buildPriorContext, parseJSON).
   ============================================================ */

function sourceBlock(chapter) {
  return `CONTENU SOURCE FOURNI PAR L'ÉTUDIANT${chapter.fromFile ? " (extrait d'un fichier : " + chapter.fromFile + ")" : ""}:\n"""\n${chapter.source}\n"""`;
}

/* ---- Inventory of ORIGINAL images extracted from the source, for re-insertion ---- */
function figuresInventory(chapter) {
  const f = (chapter && chapter.figures) || [];
  if (!f.length) return "";
  const list = f.map(x => `- ${x.id} — page ${x.page} du document (${x.w}×${x.h} px)`).join("\n");
  return `\n\nIMAGES ORIGINALES DISPONIBLES (extraites fidèlement du document source — tu n'as PAS accès à leur contenu visuel, seulement à leurs id/dimensions/page). Le texte du cours contient un marqueur \`[[FIG:fN]]\` à l'endroit exact où chacune apparaît : réinsère la figure d'origine À CET endroit avec un bloc \`\`\`img\\n<id> Légende courte\`\`\`, puis explique-la STRICTEMENT à partir de ce que dit le contenu source à son sujet (texte qui l'entoure, légende, formules ou libellés qu'elle contient et que tu peux lire dans le texte fourni) : affirme avec assurance ce qui y est explicitement indiqué — ne devine JAMAIS son contenu visuel à voix haute (pas de « la figure montre probablement... »). Si le contenu source ne dit presque rien sur elle, dis-le brièvement et limite-toi à ce qui est sûr (sa légende/sa place dans le raisonnement) plutôt que d'inventer une description. Liste des id :\n${list}\nN'emploie un id que là où il est pertinent ; chaque figure du cours doit réapparaître une fois, à sa place.`;
}

/* ---- Prompt: opening pass — title, theme, language, glossary ---- */
function buildIntroPrompt(chapter) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  const termDef = langue === "fr"
    ? `{"de":"terme allemand (ou terme technique)","fr":"traduction française","def":"définition très simple en 1 phrase en FRANÇAIS"}`
    : `{"de":"german/technical term","translation":"translation in output language","def":"simple 1-sentence definition in output language"}`;
  return `${sourceBlock(chapter)}

Respond with STRICT JSON only (no text outside JSON). All string values must be in ${LANG_LABELS[langue] || LANG_LABELS.fr} — except "langueSource" which is always "de", "fr", or "mixte".
{
  "titre": "short chapter title (max 6 words)",
  "theme": "main topic in 1 sentence",
  "langueSource": "de" or "fr" or "mixte",
  "lisible": true if content is usable, false if empty/unreadable,
  "manque": "what is missing or ambiguous (empty string if nothing)",
  "termes": [${termDef}]
}
Give 4 to 8 terms maximum, the most important ones.${langTail}`;
}

/* ---- Compact digest of previously-saved chapters, for cross-referencing ---- */
function buildPriorContext(chapters, currentId) {
  const others = (chapters || []).filter(c => c.id !== currentId && c.titre && c.lisible !== false);
  if (!others.length) return "";
  const items = others.slice(-6).map(c => {
    const fiche = (c.sections.find(s => s.n === 10 && s.status === "done") || {}).contenu || c.theme || "";
    const key = fiche.replace(/\[\[\/?C\]\]/g, "").replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 260);
    return `• ${c.titre}${c.theme ? " — " + c.theme : ""}${key ? "\n  À retenir : " + key : ""}`;
  }).join("\n");
  return "CHAPITRES DÉJÀ ÉTUDIÉS (tu peux t'y référer pour expliquer un prérequis, sans les répéter inutilement) :\n" + items;
}

/* ---- Prompt: one lesson section ---- */
function buildSectionPrompt(chapter, n, prior, vision) {
  const langue = getLangue();
  const niveau = getNiveau();
  const s = SECTIONS.find(x => x.n === n);
  const labels = getSectionLabels(n, langue);
  const glo = chapter.termes && chapter.termes.length ? (() => {
    const entries = chapter.termes.map(t =>
      langue === "fr" ? `${t.de}=${t.fr}` : `${t.de}: ${t.def || t.translation || t.fr}`
    ).join("; ");
    return `\nGLOSSARY (reuse these terms): ${entries}`;
  })() : "";
  const niveauExtra = (SECTION_GUIDE_NIVEAU_ADDENDUM[niveau] || {})[n];
  const guide = SECTION_GUIDE[n] + (niveauExtra ? " " + niveauExtra : "");
  const langTail = buildLangTail(langue);
  const figText = vision ? vision.inventoryText : figuresInventory(chapter);
  return `${sourceBlock(chapter)}${glo}${figText}${prior ? "\n\n" + prior : ""}

Write ONLY section ${n}: "${labels.titre}".
Section instruction: ${guide}
Write the section content directly (no title, no number, no JSON). Use: light Markdown + LaTeX + <<terms>> + [[C]]additions[[/C]] + \`\`\`fig\`\`\` diagrams per the rules. Clear and airy, no padding.${langTail}`;
}

/* ---- Prompts: exercises handled one-by-one for full coverage ---- */
function buildExerciseListPrompt(chapter) {
  const langTail = buildLangTail(getLangue());
  return `${sourceBlock(chapter)}

Identify ALL exercises, questions or tasks present in this content (numbered or not, including sub-questions a), b), c)).
Respond with STRICT JSON only (nothing else) — "enonce" values must be in the output language:
{"exercices":[{"ref":"1a","enonce":"short exercise statement"}]}
Do NOT invent any exercise: only those actually present. If none, return {"exercices":[]}.${langTail}`;
}

function buildSingleExercisePrompt(chapter, ex, prior, idx, total) {
  const langue = getLangue();
  const niveau = getNiveau();
  const glo = chapter.termes && chapter.termes.length
    ? "\nGLOSSARY: " + chapter.termes.map(t => langue === "fr" ? `${t.de}=${t.fr}` : `${t.de}: ${t.def || t.translation || t.fr}`).join("; ")
    : "";
  const visual = /grafisch|graphisch|zeichne|skizz|darstell|diagramm|graph|graphique|repr[ée]sent|tracer|trac[ée]|courbe|coordonn|rep[èe]re|sch[ée]ma|plot|nuage|funktion|fonction/i.test(ex.enonce || "");
  const mustFig = visual
    ? "\n\nIMPORTANT: this exercise requires a GRAPHICAL REPRESENTATION. You MUST include a \`\`\`fig\`\`\` block (type plot) with the relevant points/curve — MANDATORY. Place it JUST AFTER the title (before the steps)."
    : "";
  const levelNote = niveau === "avance"
    ? "\nLevel: ADVANCED — be direct and formal, skip elementary step-by-step details the student already knows."
    : niveau === "intermediaire"
    ? "\nLevel: INTERMEDIATE — explain the method clearly but skip truly basic operations."
    : "\nLevel: BEGINNER — explain every single step from scratch.";
  const langTail = buildLangTail(langue);
  return `${sourceBlock(chapter)}${glo}${figuresInventory(chapter)}${prior ? "\n\n" + prior : ""}

Explain EXERCISE ${ex.ref || idx} (of ${total} total) to the student.${levelNote}
Exercise statement: "${(ex.enonce || "").replace(/"/g, "'")}"

Write a COMPLETE standalone solution for THIS exercise only, in markdown, starting with "#### Exercise ${ex.ref || idx}".
Mandatory structure:
1) Guided reading of the statement (rephrase in simple terms);
2) What we are looking for exactly;
3) Method — intuition before calculations;
4) Detailed step-by-step resolution, EVERY step justified;
5) **Verification**: recalculate the result a different way to confirm;
6) Common mistake on this type of exercise.
Absolute rules:
- Never skip a step; define every technical term immediately.
- Show every calculation. If no official solution is provided, present yours as "a proposal to check against the professor's solution".
- You MAY refer to previously studied chapters to recall a prerequisite.
- Add a \`\`\`fig\`\`\` diagram whenever visual.
- Mark [[C]]…[[/C]] for anything you add beyond the course content.${mustFig}${langTail}`;
}

function buildNoExercisePrompt(chapter, prior) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  return `${sourceBlock(chapter)}${prior ? "\n\n" + prior : ""}

The provided content contains NO teacher exercise. State this clearly in one sentence, then propose ONE supplementary [[C]]training exercise[[/C]] (beginner-friendly), with a detailed step-by-step solution and **verification**. Add a \`\`\`fig\`\`\` diagram if useful. Markdown; start with "#### Training Exercise (supplement)".${langTail}`;
}

/* ---- Prompt: quiz (adaptive count) ---- */
function buildQuizPrompt(chapter) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  return `${sourceBlock(chapter)}

Create a multiple-choice QUIZ to verify understanding of this content.
Generate AS MANY questions as the content truly warrants: a light course deserves 3-4 questions, a rich dense course can justify 8-12. Minimum 2. Adapt the count to the real density and variety of concepts.
Respond with STRICT JSON only (no text outside JSON) — ALL string values ("q", "options", "explication") must be in the output language:
{"quiz":[{"q":"question","options":["A","B","C","D"],"correct":0,"explication":"why this answer, 1-2 sentences"}]}
Questions cover ONLY the provided content. 4 options per question, one correct ("correct" = index 0-3). Vary the position of the correct answer.${langTail}`;
}

/* ---- Prompt: flashcards (adaptive count) ---- */
function buildFlashPrompt(chapter) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  return `${sourceBlock(chapter)}

Create a flashcard deck (active recall) from this content.
Generate AS MANY cards as the content truly warrants: a light course deserves 4-6 cards, a dense course with many terms, formulas and algorithms can justify 12-20. Minimum 3. Cover all important concepts, key terms and formulas. Adapt the count to the real content.
Respond with STRICT JSON only (no text outside JSON) — ALL string values ("recto", "verso") must be in the output language:
{"cards":[{"recto":"question / term (short)","verso":"answer / clear definition (may include a formula $...$)"}]}
Stay faithful to the provided content.${langTail}`;
}

/* ---- Prompt: closing — what to provide next + points to verify ---- */
function buildClosingPrompt(chapter) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  return `${sourceBlock(chapter)}

Finish the lesson. Respond with STRICT JSON only (no text outside JSON) — all string values must be in the output language:
{
  "aVerifier": ["1 or 2 specific points to verify with the course or professor"],
  "prochaineEtape": "state EXACTLY what the student should provide next to continue effectively (1-2 concrete sentences)"
}${langTail}`;
}

/* ---- Robust JSON extraction from a model reply ---- */
function parseJSON(text) {
  if (!text) return null;
  let t = text.trim();
  // strip code fences
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(t); } catch (e) {}
  // find first { ... last }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {}
  }
  return null;
}

