/* ============================================================
   vision.jsx — give the AI genuine visual access to course figures
   during lesson-section generation: a per-section figure-selection
   pre-pass picks relevant ids, then their images are attached to
   the LLM call so explanations are grounded in what is actually
   seen — see docs/superpowers/specs/2026-06-08-vision-grounded-figures-design.md
   ============================================================ */

/* ---- Convert a chapter.figures[] entry's data-URI into a neutral image
   block — {id, mediaType, data} — that ai-providers.jsx forwards as-is and
   server.py / llm.py turn into the right provider-specific wire format ---- */
function figureToImageBlock(figure) {
  const m = /^data:([^;]+);base64,(.+)$/.exec((figure && figure.url) || "");
  if (!m) return null;
  return { id: figure.id, mediaType: m[1], data: m[2] };
}

/* ---- Prompt: short text-only pre-pass — which figures (if any) matter
   for THIS section? Reuses sourceBlock(chapter): the full source text with
   its [[FIG:fN]] markers, exactly what buildSectionPrompt already gets —
   no section-specific slicing exists (the 11 sections are pedagogical
   roles, not text ranges; a figure can matter for more than one). ---- */
function buildFigureSelectionPrompt(chapter, n) {
  const labels = getSectionLabels(n, getLangue());
  const guide = SECTION_GUIDE[n] || "";
  const f = (chapter && chapter.figures) || [];
  const list = f.map(x => `- ${x.id} — page ${x.page} du document (${x.w}×${x.h} px)`).join("\n");
  return `${sourceBlock(chapter)}

On prépare la section "${labels.titre}" du cours (rôle pédagogique : ${guide}).

FIGURES DISPONIBLES DANS LE DOCUMENT (id — page — dimensions) :
${list}

Pour CETTE section précisément, quelles figures (le cas échéant) seraient pertinentes à montrer et expliquer à l'étudiant ? Base-toi sur le marqueur \`[[FIG:fN]]\` dans le contenu source et sur le rôle pédagogique de la section ci-dessus — une même figure peut être pertinente pour plusieurs sections.
Respond with STRICT JSON only (no text outside JSON):
{"ids": ["f1", "f3"]}
Si aucune figure n'est pertinente pour cette section, réponds {"ids": []}. N'invente jamais un id absent de la liste ci-dessus.`;
}

/* ---- Same 3-way confidence discipline as CONFIDENCE_RULE in grounding.jsx
   (sourced / flagged-extension / honest-unknown — see grounding.jsx:8-14),
   reworded for VISUAL observation: "what I see in the image" rather than
   "what the course material says". ---- */
const VISION_CONFIDENCE_RULE = "La confiance doit venir de l'exactitude, pas du ton : n'affirme avec assurance que ce que tu observes réellement dans l'image — une fausse certitude énoncée calmement (une hallucination visuelle, ex. « la figure montre probablement... ») fait plus de mal à l'étudiant qu'un doute assumé. Distingue donc clairement TROIS choses : (1) ce que tu vois concrètement dans l'image (formes, couleurs, textes, courbes, axes, valeurs lisibles, mise en page) → décris-le avec assurance ; (2) ce que le contenu source dit à propos de cette figure (légende, texte qui l'entoure) → relie-le explicitement à ce que tu vois ; (3) ce que tu ne peux vraiment pas distinguer dans l'image (résolution insuffisante, élément ambigu, détail illisible) → dis-le simplement, sans deviner.";

/* ---- Vision-aware replacement for figuresInventory(): tells the AI it CAN
   see the attached figures' images and must describe only what's actually
   observable in them — injected into buildSectionPrompt instead of the
   honest "no visual access" text when prepareVisionContext succeeds. ---- */
function buildVisionFiguresInventory(chapter, attachedIds) {
  const f = (chapter && chapter.figures) || [];
  const attached = f.filter(x => attachedIds.includes(x.id));
  if (!attached.length) return "";
  const list = attached.map(x => `- ${x.id} — page ${x.page} du document (${x.w}×${x.h} px)`).join("\n");
  const others = f.filter(x => !attachedIds.includes(x.id)).map(x => x.id);
  const othersNote = others.length
    ? `\nAutres figures du document non jointes ici (id : ${others.join(", ")}) — tu n'as PAS accès à leur image, ne décris pas leur contenu visuel.`
    : "";
  return `\n\nIMAGES ORIGINALES JOINTES — tu PEUX VOIR le contenu visuel de ces figures (jointes à ce message, dans l'ordre de leur id ci-dessous) :
${list}
Le texte du cours contient un marqueur \`[[FIG:fN]]\` à l'endroit exact où chacune apparaît : réinsère la figure d'origine À CET endroit avec un bloc \`\`\`img\\n<id> Légende courte\`\`\`, puis explique-la à partir de ce que tu OBSERVES réellement dans l'image, relié au contexte source qui l'entoure.
${VISION_CONFIDENCE_RULE}
N'emploie un id que là où il est pertinent ; chaque figure jointe doit réapparaître une fois, à sa place.${othersNote}`;
}

/* ---- Orchestrator: figure-selection pre-pass + image conversion, wrapped
   in one try/catch. Returns either {images, inventoryText} or null — null
   means "attach nothing, fall back to figuresInventory()'s honest text",
   i.e. today's exact behavior. See the call sites in main.jsx (generation
   loop + retrySection) for how the result is threaded through. ---- */
async function prepareVisionContext(chapter, n) {
  const figures = (chapter && chapter.figures) || [];
  if (!figures.length) return null;
  try {
    const raw = await callClaude(buildFigureSelectionPrompt(chapter, n));
    const data = parseJSON(raw);
    const ids = (data && Array.isArray(data.ids))
      ? data.ids.filter(id => figures.some(f => f.id === id))
      : [];
    if (!ids.length) return null;
    const blocks = [];
    for (const id of ids) {
      const fig = figures.find(f => f.id === id);
      const block = fig && figureToImageBlock(fig);
      if (block) blocks.push(block);
    }
    if (!blocks.length) return null;
    return { images: blocks, inventoryText: buildVisionFiguresInventory(chapter, ids) };
  } catch (e) {
    return null;
  }
}
