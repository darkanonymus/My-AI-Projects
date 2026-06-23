# Architecture — Help me Learn / Learniverse

Carte du projet pour s'y retrouver vite : où vit quoi, qui dépend de quoi, et où
toucher pour ajouter/modifier une fonctionnalité (*Erweiterung / Änderung*).

> Pour l'état sécurité & la dette technique, voir [AUDIT_REPORT.md](AUDIT_REPORT.md).
> Pour l'hébergement & le déploiement, voir [deploy/README.md](deploy/README.md).

---

## 1. Vue d'ensemble

App d'apprentissage : tu importes un PDF de cours, un LLM le transforme en
**leçon structurée + quiz + flashcards**, avec lecture à voix haute, traduction
hors-ligne et suivi de progression.

- **Backend** : Python **FastAPI** (un process). Sert l'API `/api/*` **et** les
  fichiers statiques du frontend.
- **Frontend** : **sans build**. Des fichiers `web/*.jsx` chargés par
  `<script type="text/babel">` et transpilés *dans le navigateur* par
  Babel-standalone. Pas de bundler, pas de npm. Le partage de code se fait par
  variables globales `window.*` (et non par `import/export`).
- **Données** : SQLite (`data.db`), une connexion partagée protégée par un verrou.
- **Déploiement** : Docker + Caddy (HTTPS auto) sur un VPS. Voir `deploy/`.

Flux principal :
```
PDF ──/api/extract──▶ texte + figures ──▶ (frontend) prompts ──/api/llm──▶ leçon/quiz/cartes
                                                   │
                              état du cours (JSON) ─┴─/api/state──▶ SQLite (par compte)
                              images du cours ───────/api/figures──▶ SQLite (hors-bande)
lecture ──/api/tts──▶ audio   ·   question vocale ──/api/stt──▶ texte   ·   ──/api/translate──▶ autre langue
```

---

## 2. Backend (Python) — un fichier = une responsabilité

| Fichier | Rôle | Dépend de |
|---|---|---|
| `server.py` | Couche HTTP : crée l'app, monte les routes de contenu (`health`, `translate`, `tts`, `stt`, `extract`, `llm`, `state`, `figures`), sert le statique. Le **point d'entrée**. | `db`, `auth`, `ratelimit`, `llm`, `tts`, `stt`, `translate`, `extract` |
| `db.py` | **Seul propriétaire de la connexion SQLite** : verrou, tables `kv` (état des cours) + `figures` (images hors-bande). Helpers `kv_get/kv_set/fig_get/fig_set`. | — |
| `auth.py` | Comptes : hachage PBKDF2, sessions (cookie), jetons de reset + email SMTP, et le **routeur `/api/auth/*`**. Exporte `current_uid`, `state_key`. | `db`, `ratelimit` |
| `ratelimit.py` | Limiteur de débit par IP (anti-abus des endpoints coûteux). `rate_limit(request, bucket, limit, window)`. | — |
| `llm.py` | Routeur LLM : Gemini (OpenRouter), Claude, Ollama. `complete()` + `stream()`. Les clés API restent ici (jamais envoyées au navigateur). | — |
| `tts.py` | Synthèse vocale : **edge-tts** (principal, voix neurales) → **Piper** (secours hors-ligne). MP3→WAV via ffmpeg. | — |
| `stt.py` | Transcription audio (faster-whisper). | — |
| `translate.py` | Traduction hors-ligne (Argos), préserve maths/code/`<<termes>>`/`[[C]]`. | — |
| `extract.py` | Extraction PDF hybride : texte (pdf_oxide) + figures raster & vectorielles (pypdfium2 + analyse d'encre). | — |

**Graphe de dépendances backend (acyclique) :**
```
server.py ─┬─▶ db.py
           ├─▶ auth.py ──▶ db.py , ratelimit.py
           ├─▶ ratelimit.py
           └─▶ llm.py · tts.py · stt.py · translate.py · extract.py   (indépendants entre eux)
```
`deploy/predownload_translate.py` (lancé au boot) importe `translate.py` pour
pré-télécharger les modèles.

---

## 3. Frontend (web/) — sans build, couplé par `window.*`

⚠️ **À comprendre absolument** : il n'y a **pas d'`import`**. Un fichier publie ses
fonctions via `Object.assign(window, { … })` (à la fin du fichier) et les autres
les utilisent comme globales (`window.X` ou juste `X`). **Conséquence** : pour
savoir « d'où vient `callClaude` ? », il faut chercher quel fichier l'exporte
(grep `callClaude`), et **l'ordre des `<script>` dans `index.html` est un contrat** :
un fichier doit être chargé *avant* ceux qui l'utilisent.

### Ordre de chargement (= ordre dans `index.html`, à respecter)
```
1. CDN : React, ReactDOM, Babel-standalone, KaTeX, pdf.js, tesseract.js
2. lib/diagnostics.jsx     → window.HMLog (journal d'erreurs)
3. i18n.jsx                → window.ui, UI_STRINGS (traductions d'interface)
4. lib/prefs.jsx           → préférences (localStorage)
5. lib/sections.jsx        → SECTIONS, getEnabledSections, getLangue…
6. lib/ai-providers.jsx    → callClaude, callClaudeStream, getProvider…  (parle à /api/llm)
7. lib/prompts.jsx         → buildIntroPrompt, buildSectionPrompt, buildQuizPrompt…
8. lib/grounding.jsx       → buildPriorContext (contexte inter-chapitres)
9. lib/vision.jsx          → prepareVisionContext (images → LLM)
10. lib/pdf-extraction.jsx → extractFromPDF, extractFromImage  (appelle /api/extract)
11. lib/render.jsx         → renderMarkdown, renderInline, renderMath (markdown+KaTeX → React)
12. lib/study-plan.jsx     → plan d'étude
13. lib/export.jsx         → buildExportHTML, downloadFile, courseView…
14. figures.jsx            → buildFigureSVG, FigureBlock, ImageBlock (schémas ```fig```)
15. components.jsx         → Icon, BrandMark, Spinner, Tag… + ré-export des hooks React
16. lib/speech.jsx         → ReadAloudBar (lecture à voix haute, /api/tts + /api/stt)
17. learn.jsx              → LearnTab, Composer (onglet Apprendre)
18. study.jsx              → QuizTab, FlashTab (onglets Quiz / Cartes)
19. progress.jsx           → ProgressDashboard
20. planning.jsx           → ProgressTab, PlanTab
21. library.jsx            → LibraryTab (bibliothèque de cours)
22. settings.jsx           → ApiKeyModal, PrefsModal (réglages)
23. auth.jsx               → AuthModal, ResetModal (connexion / reset)
24. main.jsx               → App (assemble tout) + ReactDOM.render  ← POINT D'ENTRÉE
```

### Sous-systèmes front
- **Rendu de cours** : `lib/render.jsx` (markdown→React) + `figures.jsx` (schémas SVG).
- **Génération** : `lib/prompts.jsx` (les prompts) + `lib/ai-providers.jsx` (appel LLM), orchestrés dans `main.jsx` (`generateChapter`).
- **Audio** : `lib/speech.jsx` (un gros contrôleur TTS/STT/wake-word).
- **Onglets** : learn / study / progress / planning / library / settings.
- **Orchestrateur** : `main.jsx` → `App()` tient l'état global, la persistance (`/api/state`), l'export, la traduction.
- **Données persistées** : `web/sw.js` (service worker, cache network-first), `manifest.webmanifest` (PWA).

---

## 4. « Où je touche pour… ? » (guide rapide)

| Je veux… | Fichier(s) |
|---|---|
| Changer un **prompt** (leçon, quiz, cartes) | `web/lib/prompts.jsx` |
| Modifier le **rendu** d'une leçon (markdown, maths) | `web/lib/render.jsx` |
| Ajouter un **type de schéma** | `web/figures.jsx` (`buildFigureSVG`) |
| Toucher la **voix / lecture audio** | `tts.py` (moteur) + `web/lib/speech.jsx` (UI) |
| Changer l'**extraction PDF** | `extract.py` (serveur) |
| Ajouter une **route API** | `server.py` (ou `auth.py` pour `/api/auth/*`) |
| Toucher la **base de données** | `db.py` |
| Modifier **comptes / login / sessions** | `auth.py` (back) + `web/auth.jsx` (front) |
| Ajuster les **limites de débit** | `ratelimit.py` (def) + appels `rate_limit(...)` dans les routes |
| Changer un **moteur LLM** | `llm.py` |
| Modifier la **bibliothèque / quiz / progression** (UI) | `web/library.jsx` · `web/study.jsx` · `web/progress.jsx` |
| Ajouter un **texte d'interface** (i18n) | `web/i18n.jsx` |

---

## 5. Forme des données (état d'un cours)

L'app tourne autour d'un objet « chapitre » (= un cours), persisté en JSON dans
`kv` sous la clé `app:<uid>` :
```
{ id, titre, theme, langueSource, termes[], figures[{id,page,w,h}],
  sections[{n, titre, court, status, contenu}],
  quiz[{q, options[], correct, explication}],
  cards[{recto, verso}],
  insertions[], hiddenBlocks[], i18n{<lang>:…}, mastered, createdAt }
```
Les **images** (base64) sont retirées de ce blob et stockées à part (table
`figures`, via `/api/figures`) pour garder l'état léger. ⚠️ Cette forme est
utilisée dans `main.jsx`, `study.jsx`, `render.jsx`, `export.jsx` — un changement
de forme touche plusieurs fichiers (pas de types pour t'avertir).

---

## 6. Déploiement (résumé — détails dans `deploy/`)

- `deploy/Dockerfile` : image (FastAPI + ffmpeg + edge/Piper/Whisper/Argos), **conteneur non-root** (`gosu`), torch CPU-only.
- `deploy/entrypoint.sh` : prépare `/data`, pré-télécharge les modèles de traduction, lance le serveur en `app` (HOME=/data).
- `deploy/Caddyfile` : HTTPS auto + en-têtes de sécurité.
- **Pièges** : un changement de **Caddyfile** exige `restart caddy` ; un changement de **code/front** exige `up -d --build` (le code est *copié* dans l'image, pas monté).

---

## 7. État de la structure (honnête)

Découpé proprement : backend (§2) et lib/ frontend par concern. **Restent à améliorer** :
- Couplage `window.*` = pas de graphe de dépendances explicite (d'où ce document).
- God-files frontend : `main.jsx` (`App()`), `lib/speech.jsx`.
- Le vrai levier serait un **mini build** (esbuild) pour de vrais `import/export`.

Voir la section « Dette architecturale » de [AUDIT_REPORT.md](AUDIT_REPORT.md).
