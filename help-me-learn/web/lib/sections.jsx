/* ============================================================
   sections.jsx — the 11-section pedagogy model
   - SECTIONS: the user's exact 11-section method (canonical FR)
   - METHODE_BODY / buildMethode: faithful system-prompt blocks
     (teaching principles, anti-error rules, [[fig]]/[[img]] format)
   - SECTION_GUIDE / SECTION_GUIDE_NIVEAU_ADDENDUM: per-section and
     per-level extra guidance injected into prompts
   - buildLangTail: output-language enforcement suffix
   - SECTION_I18N / getSectionLabels: multilingual section titles
   ============================================================ */

/* ---- The 11 sections (user's exact method) ---- */
const SECTIONS = [
  { n: 1,  titre: "Ce que ce cours cherche à enseigner",          court: "Objectif" },
  { n: 2,  titre: "Les prérequis à comprendre avant de commencer", court: "Prérequis" },
  { n: 3,  titre: "Explication simple du concept principal",        court: "Intuition" },
  { n: 4,  titre: "Explication détaillée étape par étape",          court: "En détail" },
  { n: 5,  titre: "Formules, symboles ou algorithmes expliqués",    court: "Formules" },
  { n: 6,  titre: "Exemple simple",                                 court: "Exemple" },
  { n: 7,  titre: "Exercices du professeur expliqués et résolus",   court: "Exercices" },
  { n: 8,  titre: "Erreurs fréquentes et pièges",                   court: "Pièges" },
  { n: 9,  titre: "Questions pour vérifier ma compréhension",       court: "Vérif." },
  { n: 10, titre: "Fiche de révision",                              court: "Fiche" },
  { n: 11, titre: "Plan de travail conseillé pour mémoriser",       court: "Mémoriser" },
];

/* ---- Faithful method + anti-error rules, injected in every call ---- */
const METHODE_BODY = `

TON RÔLE EST STRICTEMENT EXPLICATIF. Le texte du cours est fourni TEL QUEL (extrait fidèlement du document) : tu ne le réécris pas, tu ne le résumes pas, tu ne le remplaces pas et tu n'en inventes aucune partie. Tu t'appuies sur CE contenu exact et tu apportes uniquement l'éclairage : définitions, intuition, étapes détaillées, exemples, et réinsertion des figures d'origine. Reste toujours relié au contenu fourni et aux figures extraites.

PRINCIPES PÉDAGOGIQUES (à respecter strictement) :
- Ne saute AUCUNE étape de raisonnement. Intuition d'abord, formalisme ensuite.
- Jamais de formule ou de réponse sans expliquer POURQUOI elle est utilisée.
- Ne suppose JAMAIS que l'étudiant connaît les bases : définis chaque terme technique immédiatement.
- Exemples concrets, simples, chiffrés. Pas de jargon inutile.
- Pour les termes techniques allemands : écris-les en <<terme allemand>> suivi de la traduction française.

FORMAT DU TEXTE :
- Markdown léger : paragraphes, **gras**, *italique*, listes "- " et "1. ".
- Mathématiques en LaTeX entre $ ... $ (en ligne) ou $$ ... $$ (bloc). Détaille CHAQUE symbole.
- Termes techniques importants : entoure-les de <<comme ceci>>.

RÈGLES ANTI-ERREUR (PRIORITÉ ABSOLUE) :
- Base-toi UNIQUEMENT sur le CONTENU FOURNI. N'invente jamais une définition, formule, résultat ou énoncé absent du cours.
- Tout ce que tu AJOUTES en complément général (hors du cours fourni) doit être entouré de [[C]] ... [[/C]] pour être visiblement distingué.
- Si tu n'es pas certain, écris explicitement « (à vérifier avec ton corrigé) » au lieu de deviner.
- Pour tout calcul, montre chaque étape ; recalcule les exemples pas à pas.
- Si un corrigé n'est pas fourni, propose ta solution comme une PROPOSITION à confronter au corrigé du prof, pas comme la réponse officielle.
- Si le contenu est ambigu, incomplet ou illisible, signale-le et liste ce qui manque, plutôt que de combler.

SCHÉMAS ET REPRÉSENTATIONS (RÈGLE CENTRALE) :
Quand une idée est visuelle, insère un bloc \`\`\`fig contenant UNIQUEMENT un JSON, que l'application transforme en schéma propre.
⮕ RÈGLE ABSOLUE — COLLE AU TYPE UTILISÉ DANS LE COURS : si le cours présente l'information sous forme de TABLEAU, refais un tableau (type "table") ; si c'est un ARBRE / une hiérarchie / une classification, refais un arbre (type "tree") ; si c'est une FRISE / chronologie, type "timeline" ; si c'est un HISTOGRAMME / des barres, type "bars" ; si c'est un REPÈRE / une courbe / un nuage de points, type "plot" ; si c'est une suite d'ÉTAPES (algorithme, procédure), type "flow". Ne transforme JAMAIS un tableau en liste de boîtes ni un arbre en courbe : garde la MÊME forme de représentation que le cours.
Catalogue des types disponibles :
1) Tableau — \`\`\`fig
{"type":"table","titre":"...","columns":["Colonne A","Colonne B"],"rows":[["a1","b1"],["a2","b2"]]}
\`\`\`
2) Arbre / hiérarchie / classification / arbre de décision — \`\`\`fig
{"type":"tree","titre":"...","root":{"label":"Racine","children":[{"label":"Branche 1","children":[{"label":"Feuille"}]},{"label":"Branche 2"}]}}
\`\`\`
3) Frise chronologique — \`\`\`fig
{"type":"timeline","titre":"...","events":[{"date":"1956","label":"Évènement"},{"date":"1997","label":"Évènement"}]}
\`\`\`
4) Histogramme / barres (comparer des valeurs) — \`\`\`fig
{"type":"bars","titre":"...","yLabel":"...","data":[{"label":"A","value":3},{"label":"B","value":5}]}
\`\`\`
5) Repère cartésien / courbe / nuage de points — \`\`\`fig
{"type":"plot","titre":"...","xLabel":"x","yLabel":"y","domain":[xmin,xmax],"series":[{"kind":"curve","expr":"2*x+1","label":"y=2x+1"},{"kind":"points","data":[[1,3],[2,5]],"label":"données"},{"kind":"vline","x":2},{"kind":"hline","y":0}]}
\`\`\`
   - "expr" : expression en x avec OPÉRATEURS EXPLICITES (écris 2*x, jamais 2x). Fonctions : sin cos tan exp ln log sqrt abs ; constantes pi e.
6) Étapes / algorithme / procédure — \`\`\`fig
{"type":"flow","titre":"...","nodes":["Étape 1 : ...","Étape 2 : ...","Étape 3 : ..."]}
\`\`\`
7) Graphe / réseau (nœuds reliés par des arêtes : carte de villes, graphe d'états, réseau de neurones, réseau bayésien) — \`\`\`fig
{"type":"graph","titre":"...","directed":false,"nodes":[{"id":"Arad","x":8,"y":40},{"id":"Sibiu","x":40,"y":42}],"edges":[{"from":"Arad","to":"Sibiu","label":"140"}]}
\`\`\`
   - Donne à chaque nœud une position approximative x,y (0–100, x vers la droite, y vers le BAS) reproduisant la disposition du cours. "label" d'arête = poids/distance (facultatif). "directed":true pour des flèches orientées.
Règles schémas : n'invente JAMAIS de données chiffrées, de valeurs ou de catégories absentes du cours. Pour un schéma purement illustratif d'un concept général (données non fournies), c'est permis mais marque-le en [[C]]complément[[/C]]. Garde chaque schéma simple, fidèle et lisible. N'ajoute un schéma que s'il aide réellement à comprendre — pas de schéma décoratif.
FIGURE CONNUE PERDUE À L'EXTRACTION : si le cours fait référence à une figure standard et bien identifiée (ex. une carte/un graphe d'un problème classique, un schéma canonique) mais que ses données n'apparaissent pas dans le texte fourni (souvent parce que c'était une image), tu PEUX la reconstituer fidèlement avec le bon type de schéma, et la marquer [[C]]figure reconstituée — à vérifier avec ton cours[[/C]], au lieu de te contenter d'écrire qu'elle manque.

FIGURES ORIGINALES DU COURS (RÈGLE PRIORITAIRE) : le CONTENU SOURCE peut contenir des marqueurs \`[[FIG:fN]]\` (ex. \`[[FIG:f3]]\`). Chacun indique l'EMPLACEMENT EXACT, dans le cours, d'une figure d'origine (schéma, carte, graphe, diagramme, photo) extraite du document. À CET endroit précis — c'est-à-dire dans la section de la leçon qui traite ce passage — tu DOIS :
1) réinsérer la VRAIE figure du cours avec un bloc :
\`\`\`img
fN Légende courte
\`\`\`
(par ex. \`\`\`img\\nf3 Carte des villes de Roumanie\`\`\`) ;
2) puis l'expliquer brièvement : ce qu'elle représente, comment la lire, ce qu'il faut y remarquer — TOUJOURS en lien direct avec ce passage du cours.
Ne déplace JAMAIS une figure hors de son contexte d'origine, n'en invente aucune, n'en oublie aucune : chaque \`[[FIG:fN]]\` du cours doit réapparaître une fois, à sa place, sous forme de bloc \`\`\`img\`\`\`. N'utilise QUE des id réellement présents dans le contenu source. Si la liste « IMAGES ORIGINALES DISPONIBLES » mentionne un id qui n'apparaît dans aucun marqueur, place-le dans la section la plus pertinente. PRIVILÉGIE toujours la figure d'origine du cours plutôt que d'en redessiner une approximative.`;

const LANG_LABELS = {
  fr: "TOUJOURS en FRANÇAIS clair",
  en: "ALWAYS in clear ENGLISH",
  de: "IMMER auf klarem DEUTSCH",
  es: "SIEMPRE en ESPAÑOL claro",
  it: "SEMPRE in ITALIANO chiaro",
  pt: "SEMPRE em PORTUGUÊS claro",
};

function buildMethode(niveau, langue) {
  const langLabel = LANG_LABELS[langue] || LANG_LABELS.fr;

  const niveauDesc = {
    debutant:      "pour débutants COMPLETS (niveau zéro en maths, programmation, logique, statistiques)",
    intermediaire: "pour apprenants INTERMÉDIAIRES (bases en maths et informatique acquises — va à l'essentiel, ne réexplique pas les notions élémentaires connues)",
    avance:        "pour apprenants AVANCÉS (maîtrise des fondamentaux — sois formel, direct, utilise le vocabulaire technique sans détours)",
  }[niveau] || "pour débutants COMPLETS (niveau zéro en maths, programmation, logique, statistiques)";

  const glossNote = langue === "fr"
    ? "- Pour les termes techniques allemands : écris-les en <<terme allemand>> suivi de la traduction française."
    : langue === "de"
    ? "- Für deutsche Fachbegriffe: schreibe sie als <<Fachbegriff>> direkt im Text."
    : "- For German technical terms: write them as <<german term>> followed by a translation in your output language.";

  return `Tu es un professeur expert en intelligence artificielle (KI) et en pédagogie ${niveauDesc}.
Source material is often in GERMAN. Your ENTIRE response (every word, every label, every explanation) must be ${langLabel} — this rule overrides everything else.

${METHODE_BODY.replace(
  "- Pour les termes techniques allemands : écris-les en <<terme allemand>> suivi de la traduction française.",
  glossNote
)}

⚡ ABSOLUTE OUTPUT LANGUAGE RULE: Write ${langLabel}. Do NOT use any other language in your response, even if the instructions above are written in French.`;
}

/* ---- Per-section extra guidance ---- */
const SECTION_GUIDE = {
  1: "Identifie le thème principal et à quoi il sert en IA. 2 courts paragraphes max.",
  2: "Liste les prérequis, même les plus basiques (en '- '). Pour chacun, une phrase d'explication.",
  3: "Explique l'intuition du concept principal comme une découverte, avec une analogie simple du quotidien.",
  4: "Déroule le raisonnement étape par étape (liste numérotée '1. '). Chaque étape = une idée, expliquée.",
  5: "Présente les formules/symboles/algorithmes. Pour CHAQUE formule : pourquoi elle existe, ce que représente chaque symbole, comment on l'utilise, l'idée générale d'où elle vient. Utilise $$...$$.",
  6: "Un exemple simple et CHIFFRÉ, résolu pas à pas, pour ancrer le concept.",
  7: "Reprends les exercices présents dans le contenu fourni : lecture guidée de l'énoncé, ce qu'on cherche, méthode, résolution détaillée pas à pas, explication de chaque choix. Si AUCUN exercice n'est fourni, dis-le clairement et propose 1 exercice d'entraînement [[C]]complémentaire[[/C]] avec sa correction.",
  8: "Les erreurs fréquentes et pièges classiques sur ce thème (liste '- ').",
  9: "Pose 3 questions de vérification courtes (liste numérotée). Donne la réponse attendue en italique juste après chaque question.",
  10: "Fiche de révision ULTRA-condensée : les 4-6 points à retenir absolument (liste '- '), formules clés incluses.",
  11: "Un mini-plan concret pour mémoriser CE contenu (révision active, espacée). 3-4 étapes datées relatives (J+0, J+1, J+3, J+7).",
};

/* ---- Niveau-aware addendum injected after the base guide ---- */
const SECTION_GUIDE_NIVEAU_ADDENDUM = {
  intermediaire: {
    2: "Ne liste pas les notions très basiques supposées connues. Cible uniquement les prérequis spécifiques à CE concept.",
    3: "L'analogie du quotidien est optionnelle — une intuition précise et directe suffit.",
    4: "Pas besoin de micro-détailler chaque opération mathématique élémentaire. Concentre-toi sur les spécificités.",
    9: "Pose des questions qui vont au-delà de la définition — compréhension et application.",
  },
  avance: {
    2: "Liste UNIQUEMENT les prérequis non-triviaux et spécifiques. Ignore les notions générales.",
    3: "Pas d'analogie du quotidien. Intuition formelle directe, concise.",
    4: "Notation formelle directe. Zéro micro-explication sur les fondamentaux mathématiques.",
    5: "Ne décompose pas chaque symbole élémentaire — concentre-toi sur les aspects non-triviaux et les subtilités.",
    6: "Exemple concis et chiffré, résolution directe sans sur-détailler les étapes élémentaires.",
    9: "Questions de haut niveau : cas limites, comparaisons entre méthodes, implications théoriques.",
    11: "Plan de révision resserré, orienté approfondissement et applications avancées.",
  },
};

/* ---- Language suffix — written IN the target language for max LLM compliance ---- */
function buildLangTail(langue) {
  if (langue === "fr") return "";
  const rules = {
    en: "\n\n⚡ MANDATORY — NON-NEGOTIABLE: Your COMPLETE response must be in ENGLISH. Every single word, every label, every title, every example. Even if the instructions above are in French, your OUTPUT is in ENGLISH only.",
    de: "\n\n⚡ PFLICHT — NICHT VERHANDELBAR: Deine GESAMTE Antwort muss auf DEUTSCH sein. Jedes einzelne Wort, jede Bezeichnung, jeder Titel, jedes Beispiel. Auch wenn die Anweisungen oben auf Französisch sind, ist deine AUSGABE ausschließlich auf DEUTSCH.",
    es: "\n\n⚡ OBLIGATORIO — NO NEGOCIABLE: Tu respuesta COMPLETA debe estar en ESPAÑOL. Cada palabra, cada etiqueta, cada título, cada ejemplo. Aunque las instrucciones de arriba estén en francés, tu SALIDA es únicamente en ESPAÑOL.",
    it: "\n\n⚡ OBBLIGATORIO — NON NEGOZIABILE: La tua risposta COMPLETA deve essere in ITALIANO. Ogni parola, ogni etichetta, ogni titolo, ogni esempio. Anche se le istruzioni sopra sono in francese, il tuo OUTPUT è esclusivamente in ITALIANO.",
    pt: "\n\n⚡ OBRIGATÓRIO — NÃO NEGOCIÁVEL: Toda a sua resposta deve estar em PORTUGUÊS. Cada palavra, cada rótulo, cada título, cada exemplo. Mesmo que as instruções acima estejam em francês, a sua SAÍDA é exclusivamente em PORTUGUÊS.",
  };
  return rules[langue] || `\n\n⚡ MANDATORY: Respond entirely in ${LANG_LABELS[langue]}.`;
}

/* ---- Multilingual section titles (stored in chapter data + used in prompts) ---- */
const SECTION_I18N = {
  1:  { fr:{titre:"Ce que ce cours cherche à enseigner",court:"Objectif"}, en:{titre:"What this course aims to teach",court:"Objective"}, de:{titre:"Was dieser Kurs vermittelt",court:"Ziel"}, es:{titre:"Qué enseña este curso",court:"Objetivo"}, it:{titre:"Cosa insegna questo corso",court:"Obiettivo"}, pt:{titre:"O que este curso ensina",court:"Objetivo"} },
  2:  { fr:{titre:"Les prérequis à comprendre avant de commencer",court:"Prérequis"}, en:{titre:"Prerequisites to understand",court:"Prerequisites"}, de:{titre:"Voraussetzungen",court:"Voraussetzungen"}, es:{titre:"Prerrequisitos",court:"Prerrequisitos"}, it:{titre:"Prerequisiti",court:"Prerequisiti"}, pt:{titre:"Pré-requisitos",court:"Pré-requisitos"} },
  3:  { fr:{titre:"Explication simple du concept principal",court:"Intuition"}, en:{titre:"Simple explanation of the main concept",court:"Intuition"}, de:{titre:"Einfache Erklärung des Hauptkonzepts",court:"Intuition"}, es:{titre:"Explicación simple del concepto principal",court:"Intuición"}, it:{titre:"Spiegazione semplice del concetto principale",court:"Intuizione"}, pt:{titre:"Explicação simples do conceito principal",court:"Intuição"} },
  4:  { fr:{titre:"Explication détaillée étape par étape",court:"En détail"}, en:{titre:"Detailed step-by-step explanation",court:"In detail"}, de:{titre:"Schritt-für-Schritt-Erklärung",court:"Im Detail"}, es:{titre:"Explicación detallada paso a paso",court:"En detalle"}, it:{titre:"Spiegazione dettagliata passo dopo passo",court:"In dettaglio"}, pt:{titre:"Explicação detalhada passo a passo",court:"Em detalhe"} },
  5:  { fr:{titre:"Formules, symboles ou algorithmes expliqués",court:"Formules"}, en:{titre:"Formulas, symbols or algorithms explained",court:"Formulas"}, de:{titre:"Formeln, Symbole oder Algorithmen erklärt",court:"Formeln"}, es:{titre:"Fórmulas, símbolos o algoritmos explicados",court:"Fórmulas"}, it:{titre:"Formule, simboli o algoritmi spiegati",court:"Formule"}, pt:{titre:"Fórmulas, símbolos ou algoritmos explicados",court:"Fórmulas"} },
  6:  { fr:{titre:"Exemple simple",court:"Exemple"}, en:{titre:"Simple example",court:"Example"}, de:{titre:"Einfaches Beispiel",court:"Beispiel"}, es:{titre:"Ejemplo simple",court:"Ejemplo"}, it:{titre:"Esempio semplice",court:"Esempio"}, pt:{titre:"Exemplo simples",court:"Exemplo"} },
  7:  { fr:{titre:"Exercices du professeur expliqués et résolus",court:"Exercices"}, en:{titre:"Worked exercises from the course",court:"Exercises"}, de:{titre:"Aufgaben des Professors — erklärt und gelöst",court:"Übungen"}, es:{titre:"Ejercicios del profesor explicados y resueltos",court:"Ejercicios"}, it:{titre:"Esercizi del professore spiegati e risolti",court:"Esercizi"}, pt:{titre:"Exercícios do professor explicados e resolvidos",court:"Exercícios"} },
  8:  { fr:{titre:"Erreurs fréquentes et pièges",court:"Pièges"}, en:{titre:"Common mistakes and pitfalls",court:"Pitfalls"}, de:{titre:"Häufige Fehler und Fallen",court:"Fallen"}, es:{titre:"Errores frecuentes y trampas",court:"Errores"}, it:{titre:"Errori frequenti e trabocchetti",court:"Errori"}, pt:{titre:"Erros frequentes e armadilhas",court:"Erros"} },
  9:  { fr:{titre:"Questions pour vérifier ma compréhension",court:"Vérif."}, en:{titre:"Questions to check my understanding",court:"Check"}, de:{titre:"Fragen zur Überprüfung des Verständnisses",court:"Prüfung"}, es:{titre:"Preguntas de comprensión",court:"Verificar"}, it:{titre:"Domande di verifica",court:"Verifica"}, pt:{titre:"Perguntas de verificação",court:"Verificação"} },
  10: { fr:{titre:"Fiche de révision",court:"Fiche"}, en:{titre:"Summary sheet",court:"Summary"}, de:{titre:"Zusammenfassung",court:"Zusammenfassung"}, es:{titre:"Ficha de revisión",court:"Resumen"}, it:{titre:"Scheda di revisione",court:"Riepilogo"}, pt:{titre:"Ficha de revisão",court:"Resumo"} },
  11: { fr:{titre:"Plan de travail conseillé pour mémoriser",court:"Mémoriser"}, en:{titre:"Recommended study plan",court:"Memorize"}, de:{titre:"Empfohlener Lernplan",court:"Einprägen"}, es:{titre:"Plan de estudio recomendado",court:"Memorizar"}, it:{titre:"Piano di studio consigliato",court:"Memorizzare"}, pt:{titre:"Plano de estudo recomendado",court:"Memorizar"} },
};

function getSectionLabels(n, langue) {
  const row = SECTION_I18N[n];
  if (!row) return { titre: "Section " + n, court: String(n) };
  return row[langue] || row.fr;
}

/* ui() and UI_STRINGS are defined in i18n.jsx (loaded before lib.jsx) */

