/* ============================================================
   grounding.jsx — prompt builders for in-lesson contextual Q&A
   "Grounding" = answer from the course/source material first,
   fall back to general knowledge only if truly absent — see
   docs/superpowers/specs/2026-06-08-contextual-qa-design.md §6
   ============================================================ */

/* ---- Shared tone rule: confidence must come from being RIGHT, not from
   sounding sure — a calmly-stated hallucination is worse for the student
   than an honest "I'm not certain". The fix isn't banning doubt outright
   (that just relabels guesses as facts); it's forcing the model to separate
   sourced claims, domain-standard extensions, and genuine unknowns instead
   of blurring all three under one vague "probablement". ---- */
const CONFIDENCE_RULE = "La confiance doit venir de l'exactitude, pas du ton : n'affirme avec assurance que ce dont tu es réellement sûr — une fausse certitude énoncée calmement (une hallucination) fait plus de mal à l'étudiant qu'un doute assumé. Distingue donc clairement TROIS choses dans ta réponse : (1) ce qui vient du cours/de la source → affirme-le sans détour ; (2) ce qui est une extension de ta part fondée sur des connaissances solides du domaine → présente-le explicitement comme tel (« au-delà du cours, l'explication généralement retenue est... »), pas comme un vague « probablement » qui jette le doute sur l'ensemble sans rien préciser ; (3) ce que tu ne sais vraiment pas avec certitude → dis-le simplement et honnêtement, sans le déguiser en fait ni le noyer dans une supposition floue.";

/* ---- Prompt: answer a question about a selected passage ---- */
function buildAskPrompt(chapter, section, passage, question) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  return `${sourceBlock(chapter)}

SECTION EN COURS DE LECTURE — "${section.titre}" :
"""
${section.contenu}
"""

PASSAGE SÉLECTIONNÉ PAR L'ÉTUDIANT :
"""
${passage}
"""

QUESTION DE L'ÉTUDIANT SUR CE PASSAGE :
"${question.replace(/"/g, "'")}"

Réponds D'ABORD en te basant sur le contenu source et/ou la section ci-dessus ; si l'information n'y est vraiment pas, réponds avec tes connaissances générales, de façon simple et cohérente avec le niveau et la langue du cours, et indique-le clairement.
${CONFIDENCE_RULE}
Reste court et clair (3 à 6 phrases, markdown léger autorisé, formules $...$ si utile), adapté au niveau de l'étudiant.
Respond with STRICT JSON only (no text outside JSON) — "reponse" must be in the output language:
{"reponse": "ta réponse ici", "trouveDansLeCours": true ou false}${langTail}`;
}

/* ---- Prompt: a simpler/more concrete example for a selected passage ---- */
function buildExamplePrompt(chapter, section, passage) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  return `${sourceBlock(chapter)}

SECTION EN COURS DE LECTURE — "${section.titre}" :
"""
${section.contenu}
"""

PASSAGE SÉLECTIONNÉ PAR L'ÉTUDIANT (jugé trop abstrait) :
"""
${passage}
"""

Propose UN exemple plus concret et plus simple pour illustrer ce passage précis. Si un exemple existe déjà à proximité dans la section, construis-en un DIFFÉRENT et plus simple sur le même concept ; sinon construis-en un nouveau, fidèle au passage et adapté au niveau et à la langue du cours.
${CONFIDENCE_RULE}
Reste court et clair (3 à 6 phrases, markdown léger autorisé, formules $...$ si utile).
Respond with STRICT JSON only (no text outside JSON) — "reponse" must be in the output language:
{"reponse": "ton exemple ici", "trouveDansLeCours": true ou false}${langTail}`;
}

/* ---- Prompt: anti-duplicate check before adding to quiz/flashcards ---- */
function buildBankCheckPrompt(chapter, passage) {
  const langue = getLangue();
  const langTail = buildLangTail(langue);
  const cardTitles = (chapter.cards || []).map(c => c.recto).filter(Boolean);
  const quizTitles = (chapter.quiz || []).map(q => q.q).filter(Boolean);
  const cardList = cardTitles.length ? cardTitles.map(t => "- " + t).join("\n") : "(aucune)";
  const quizList = quizTitles.length ? quizTitles.map(t => "- " + t).join("\n") : "(aucune)";
  return `${sourceBlock(chapter)}

PASSAGE SÉLECTIONNÉ PAR L'ÉTUDIANT :
"""
${passage}
"""

FLASHCARDS EXISTANTES (intitulés seulement) :
${cardList}

QUESTIONS DE QUIZ EXISTANTES (intitulés seulement) :
${quizList}

Pour CE passage, vérifie s'il est déjà couvert par une flashcard et/ou une question de quiz existante (même concept, formulation différente acceptée). Si NON couvert, propose une nouvelle carte et/ou une nouvelle question de quiz fidèle au passage et au niveau du cours ; 4 options pour le quiz, une seule correcte.
${CONFIDENCE_RULE}
Respond with STRICT JSON only (no text outside JSON) — string values in the output language:
{
  "card": {"déjàCouvert": false, "doublonDe": "", "recto": "question / terme court", "verso": "réponse / définition claire"},
  "quiz": {"déjàCouvert": false, "doublonDe": "", "q": "question", "options": ["A","B","C","D"], "correct": 0, "explication": "pourquoi, 1-2 phrases"}
}
Si déjàCouvert=true pour l'un des deux, indique dans "doublonDe" l'intitulé existant concerné et laisse les autres champs vides / à 0 / [].${langTail}`;
}
