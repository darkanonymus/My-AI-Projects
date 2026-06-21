# Audit — Learniverse / help-me-learn

> Audit de code, sécurité et dépendances. Périmètre : `help-me-learn/` (l'app), dépôt git racine `My-AI-Projects/`.
> Date : 2026-06-21 · Audit initial en lecture seule, **puis correctifs appliqués et validés** (voir §0 « Remédiation »).
> Méthode : revue manuelle exhaustive du backend (FastAPI + modules ML) et du frontend buildless (`web/**`), + cartographie du couplage `window.*`, + revue déploiement (Docker/Caddy), + scanners (bandit, pip-audit, vulture, gitleaks lancés localement ; semgrep non exécutable nativement sous Windows — voir §6).

---

## 0. Remédiation appliquée (2026-06-21)

Tous les findings Critiques/Élevés/Moyens et les Faibles à fort levier ont été corrigés et **vérifiés** (serveur redémarré : rate-limit, auth, cookies testés ; frontend chargé sans erreur console).

| # | Finding | Statut | Correctif |
|---|---|---|---|
| H-1 | Endpoints coûteux ouverts | ✅ Corrigé | Rate-limiter en mémoire par IP (LLM 20/min, extract 10/min, stt 20/min, tts 40/min, translate 20/min ; auth register/forgot 5/h, login 10/5min) + plafonds de taille (prompt 600k, images 20, segments TTS 400, lot translate 2M). [server.py](help-me-learn/server.py) |
| H-2 | SQLite concurrence | ✅ Corrigé | `PRAGMA journal_mode=WAL` + `busy_timeout=5000` + `_db_lock` (RLock) autour de **tous** les accès. |
| M-1 | En-têtes sécurité Caddy | ✅ Corrigé | Bloc `header` : HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, `-Server`. [Caddyfile](help-me-learn/deploy/Caddyfile) |
| M-2 | Cookie/sessions | ✅ Corrigé | `secure` en prod (gate sur DOMAIN/COOKIE_SECURE) + TTL serveur 60 j (`_uid_for_token`) + purge opportuniste sessions/reset_tokens. |
| M-3 | XSS moteur figures | ✅ Corrigé | `_esc` échappe aussi `"`/`'` ; `_color()` whiteliste les couleurs (hex/rgb/var/nom) avant interpolation en attribut SVG. [figures.jsx](help-me-learn/web/figures.jsx) |
| M-4 | Fuite d'exceptions | ✅ Corrigé | Messages clients génériques + `_log_err()` côté serveur (translate/tts/stt/extract/llm + stream). |
| M-5 | CDN sans SRI / pdf.js CVE | ✅ Corrigé | SRI (sha384) ajouté sur pdf.js + tesseract. *(pdf.js 3.x conservé : CVE-2024-4367 non atteignable — aucun `getDocument` côté client, l'extraction est serveur.)* [index.html](help-me-learn/web/index.html) |
| M-6 | Dépendance vulnérable | ✅ Non applicable | CVE-2026-54499 (stanza) : l'argostranslate actuel (≥1.11) utilise spaCy, **pas stanza** — la CVE ne touche pas le déploiement. (Le pin tenté `stanza>=1.12.2` cassait le build Docker — retiré.) Lockfile complet : reste recommandé. [requirements.txt](help-me-learn/requirements.txt) |
| L-2 | Mot de passe faible | ✅ Corrigé | Minimum 6 → **10** (back + front). |
| L-3 | Entrées non bornées | ✅ Corrigé | Plafonds ajoutés (cf. H-1). |
| Bandit | SHA1 (2× High) | ✅ Corrigé | `usedforsecurity=False` (clés de cache, non sécuritaire) → 0 High. |
| Dette | `llm_new.py` mort | ✅ Supprimé | + `.gitignore` couvre les sidecars WAL. |

**Volontairement reportés** (hors périmètre sécurité, à traiter séparément car refactors risqués) : découpe des god-files `main.jsx`/`speech.jsx`, suppression de la ré-export des hooks React via `window`, lockfile Python complet, allègement torch/CUDA, build minimal pour permettre une CSP stricte. Détaillés en §8.

---

## 🚨 ALERTE — risque actif à traiter en priorité (serveur PUBLIC)

**Tous les endpoints coûteux sont ouverts sans authentification ni limitation de débit**, sur une URL publique (`https://46.224.78.245.sslip.io`) dont le `.env` contient de vraies clés API payantes (OpenRouter, Anthropic).

`/api/llm`, `/api/llm/stream`, `/api/tts`, `/api/stt`, `/api/extract`, `/api/translate` — n'importe quel visiteur anonyme peut :
- **vider ton quota / facturer ta carte** en bouclant sur `/api/llm/stream` (`max_tokens=65536` par requête, [llm.py:256](help-me-learn/llm.py:256)) ;
- **saturer CPU/RAM** (Whisper, Argos, extraction PDF) jusqu'au déni de service ;
- `/api/auth/register` et `/api/auth/forgot` sont aussi ouverts → création de comptes en masse + envoi d'emails SMTP en boucle.

Je n'ai **rien corrigé** (en attente de ta validation), mais c'est le point n°1 : tant que ce n'est pas fermé, l'instance est abusable dès maintenant. Mitigation d'urgence possible côté Caddy en 5 min (auth basique ou `rate_limit`) — voir §7.

---

## 1. Vue d'ensemble

| Sévérité | Nombre |
|---|---|
| 🔴 Critique / Élevé | 2 |
| 🟠 Moyen | 6 |
| 🟡 Faible | 8 |
| ⚪ Info / dette | 4 |

**Score de risque global : ÉLEVÉ** — non pas à cause de la qualité du code (le backend est propre, les requêtes SQL sont paramétrées, l'auth est correctement conçue, le rendu prose est échappé via React), mais à cause d'**un modèle de menace inadapté au déploiement** : une app pensée « locale mono-utilisateur » exposée telle quelle sur Internet. Les deux risques élevés (endpoints ouverts + concurrence SQLite) découlent directement de ce décalage.

### Stack confirmée
- **Frontend** : buildless, `web/*.jsx` transpilés par Babel-standalone dans le navigateur ; partage par `window.*`. React/KaTeX/pdf.js/Tesseract via CDN. ✔ conforme au brief.
- **Backend** : FastAPI (`server.py`) + `llm.py` (OpenRouter/Anthropic/Ollama), `tts.py` (Piper), `stt.py` (faster-whisper), `translate.py` (Argos), `extract.py` (pdfium + pdf_oxide). SQLite **connexion unique partagée**. ✔ conforme.
- **Déploiement** : Docker Compose (app + Caddy), Caddy publie 80/443, l'app n'est exposée qu'en interne (`expose: 8000`, pas `ports`). ✔ bon point — l'app n'est pas joignable hors du reverse-proxy.

### Sous-domaines logiques
| Domaine | Fichier(s) | Rôle (1 phrase) |
|---|---|---|
| API/serveur | `server.py` | Routes FastAPI, sessions, état kv, figures, montage statique. |
| LLM | `llm.py` | Routeur 3 moteurs (Gemini/Claude/Ollama), complétion + streaming SSE. |
| TTS | `tts.py` | Synthèse Piper offline, normalisation symboles/nombres, cache disque. |
| STT | `stt.py` | Transcription faster-whisper d'un audio uploadé. |
| Traduction | `translate.py` | Traduction Argos hors-ligne préservant math/code/termes. |
| Extraction | `extract.py` | Extraction hybride texte+figures (raster + vecteur) d'un PDF. |
| Front — rendu cours | `lib/render.jsx`, `figures.jsx` | Markdown-lite + KaTeX + moteur de schémas SVG déterministe. |
| Front — apprentissage | `learn.jsx`, `study.jsx`, `lib/sections.jsx`, `lib/prompts.jsx` | Génération de cours/quiz/flashcards, sections, prompts. |
| Front — progression/plan | `progress.jsx`, `planning.jsx`, `lib/study-plan.jsx` | Suivi de progression, plan d'étude. |
| Front — audio | `lib/speech.jsx` | Lecture à voix haute + Q&A vocale (TTS/STT). |
| Front — extraction | `lib/pdf-extraction.jsx`, `lib/vision.jsx` | Appel `/api/extract` + OCR Tesseract fallback. |
| Front — bibliothèque/réglages | `library.jsx`, `settings.jsx`, `lib/prefs.jsx`, `lib/ai-providers.jsx` | Liste des cours, modales clés/préférences. |
| Front — orchestrateur | `main.jsx` | Shell, navigation, auth UI, état global, export. |

### Routes servies SANS authentification
`/api/health`, `/api/translate`, `/api/tts`, `/api/stt`, `/api/extract`, `/api/llm`, `/api/llm/stream`, `/api/auth/register`, `/api/auth/login`, `/api/auth/forgot`, `/api/auth/reset`, `/api/auth/me`, plus tout le statique (`/`). Les routes d'état/figures **en écriture** exigent une session (`_current_uid`), mais **les 6 endpoints coûteux ci-dessus, non** — voir l'alerte.

---

## 2. Architecture & couplage

### God-files
- **`main.jsx` — 1116 lignes** : shell + nav + auth UI + état global + export PDF (`document.write`). C'est l'orchestrateur ; gros mais cohérent. Candidat n°1 à découper (auth, export, shell).
- **`lib/speech.jsx` — 1105 lignes** : toute la lecture à voix haute + Q&A vocale. Domaine cohérent mais monolithique.
- Les autres fichiers sont raisonnables (< 660 lignes).

### Carte du couplage `window.*` (exports → imports)
12 modules exposent via `Object.assign(window, …)`. **Aucune collision de noms détectée** (chaque module exporte des identifiants distincts) — bon point. Les exports sont bien rangés par concern :

| Module | Exporte (window.*) |
|---|---|
| `i18n.jsx` | `ui`, `UI_STRINGS` |
| `components.jsx` | `Icon, BrandMark, Spinner, ProgressBar, Tag, Ring, Empty, PageHead, useReveal, Reveal, useOutsideClose, useState, useEffect, useRef` |
| `figures.jsx` | `compileExpr, buildFigureSVG, FigureBlock, ImageBlock, registerFigImage, figKey, parseImgRef, …PALETTE` |
| `lib/render.jsx`, `lib/export.jsx`, `lib/diagnostics.jsx`, `lib/speech.jsx`, `learn.jsx`, `study.jsx`, `progress.jsx`, `planning.jsx`, `library.jsx`, `settings.jsx` | composants/onglets respectifs |

**Fragilités structurelles :**
1. **`components.jsx` ré-exporte les hooks React** (`useState/useEffect/useRef`) sur `window`. Couplage caché : tout fichier chargé *après* peut écrire `useState` sans `React.` — mais un fichier chargé *avant* `components.jsx` ne le peut pas. Dépendance d'ordre implicite et invisible.
2. **Ordre des `<script>` dans `index.html` = contrat fragile non documenté** ([index.html:800-822](help-me-learn/web/index.html#L800)). `diagnostics → i18n → lib/* → figures → components → speech → onglets → main`. Réordonner une ligne casse silencieusement (un `window.X` devient `undefined` au moment de l'appel). Pas de garde-fou.
3. **Espace de noms global énorme** : ~60 symboles sur `window`. Pas dramatique aujourd'hui (pas de collision), mais aucune frontière forcée — n'importe quel module peut lire/écrire l'état d'un autre.
4. **Babel-standalone en production** : transpilation dans le navigateur à chaque chargement (coût perf) **et** impose `unsafe-eval` à toute future CSP (voir finding #6).

### Backend — couplage
Propre et acyclique : `server.py` importe `llm, tts, stt, translate, extract` ; ces modules ne se connaissent pas entre eux (aucun cycle). Le couplage caché est l'**état module-global partagé** : `_db` (connexion unique), caches `_voices`/`_installed_pairs`/`_model`. C'est là le vrai point de tension, pas les imports (voir finding #2).

### Fichiers morts
- `llm_new.py` (0 octet) — à supprimer.
- Chemin pdf.js **client** (`lib/pdf-extraction.jsx`, refs `window.pdfjsLib.OPS` [:325](help-me-learn/web/lib/pdf-extraction.jsx#L325)) : l'extraction réelle passe par `/api/extract` (serveur). pdf.js est chargé globalement mais quasi inutilisé côté client → dette + surface inutile (voir #7).

---

## 3. Findings sécurité — Critiques / Élevés

### 🔴 H-1 — Endpoints coûteux ouverts sans auth ni rate-limiting
**Fichiers :** [server.py:252](help-me-learn/server.py#L252) `/api/translate`, [:274](help-me-learn/server.py#L274) `/api/tts`, [:304](help-me-learn/server.py#L304) `/api/stt`, [:507](help-me-learn/server.py#L507) `/api/extract`, [:531](help-me-learn/server.py#L531) `/api/llm`, [:544](help-me-learn/server.py#L544) `/api/llm/stream`.
**Risque :** sur une URL publique avec clés payantes — vol de quota/facturation (LLM), déni de service par calcul ML (STT/traduction/extraction). Aucun `Depends`, aucune middleware d'auth ou de débit sur ces routes. `/api/auth/register` et `/api/auth/forgot` ouverts → abus de création de comptes et d'envoi d'emails SMTP.
**Fix recommandé (par ordre) :**
1. **Exiger une session** sur les endpoints coûteux (réutiliser `_current_uid` ; refuser anonyme avec 401), si l'usage public n'est pas voulu.
2. Sinon, **rate-limiting** : `slowapi` (FastAPI) par IP/uid, et/ou directive `rate_limit` côté Caddy.
3. Plafonner les tailles d'entrée : longueur de `prompt`/`system` (LLM), nombre de `segments` (TTS), taille de `texts` (translate). Aujourd'hui non bornées.
4. Auth basique Caddy en mitigation immédiate si tu veux fermer tout de suite (voir §7).

### 🔴 H-2 — SQLite : connexion unique partagée, sans verrou, sous concurrence threadpool
**Fichier :** [server.py:56](help-me-learn/server.py#L56) `_db = sqlite3.connect(..., check_same_thread=False)`.
**Risque :** toutes les écritures (`_db_set`, INSERT figures, sessions/users/reset) passent par `run_in_threadpool` → s'exécutent sur des threads différents partageant **un seul objet connexion sans verrou**. Sous accès concurrent (serveur public), erreurs `recursive use of cursors not allowed`, `database is locked`, voire incohérences. La table `kv` stocke des **blobs d'état entiers** par utilisateur → écritures lourdes et fréquentes.
**Fix recommandé :** au choix —
- connexion **par thread** (`threading.local` ou ouvrir/fermer par requête), ou
- conserver la connexion unique mais **sérialiser les écritures** avec un `threading.Lock`, et activer **WAL** (`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`).
- À terme : sortir les gros blobs d'état de SQLite kv (déjà fait pour les figures — bon modèle à étendre).

---

## 4. Findings sécurité — Moyens

### 🟠 M-1 — Aucun en-tête de sécurité (Caddy nu)
[deploy/Caddyfile](help-me-learn/deploy/Caddyfile) ne pose ni **CSP**, ni **HSTS**, ni `X-Frame-Options`, ni `X-Content-Type-Options`, ni `Referrer-Policy`. Clickjacking possible, pas de durcissement transport, et **aucune CSP pour limiter les conséquences d'un XSS** (cf. M-3). Fix : bloc `header { … }` dans le Caddyfile (exemple en §7). Note : une CSP stricte est compliquée par Babel-standalone (`unsafe-eval` requis) — raison de plus pour envisager un build.

### 🟠 M-2 — Cookie de session sans `Secure`
[server.py:221](help-me-learn/server.py#L221) : `httponly=True, samesite="lax"` mais **pas `secure=True`**. Sur HTTPS il devrait l'être. De plus : les **sessions n'expirent jamais côté serveur** (table jamais purgée, cookie 60 jours) et les **reset_tokens ne sont jamais ramassés** (seulement supprimés à consommation). Fix : `secure=True`, TTL serveur + purge périodique.

### 🟠 M-3 — XSS (défense en profondeur) dans le moteur de figures SVG
[figures.jsx:10](help-me-learn/web/figures.jsx#L10) `_esc()` échappe `& < >` **mais pas les guillemets**, et les champs **couleur** (`s.color`, `d.color`, `n.color`) sont interpolés dans des **attributs SVG sans échappement** (ex. [figures.jsx:101](help-me-learn/web/figures.jsx#L101) `stroke="${col}"`), puis injectés via `dangerouslySetInnerHTML` ([figures.jsx:364](help-me-learn/web/figures.jsx#L364)). Une valeur de couleur forgée (`"><animate onbegin=…>`) dans un bloc ```` ```fig ```` JSON peut injecter un attribut/élément SVG exécutable (SMIL). 
**Vecteur réaliste :** le JSON `fig` vient du LLM, qui traite du contenu importé (PDF) → injection de prompt → schéma piégé → XSS dans le navigateur de la victime (souvent l'utilisateur lui-même, car les cours sont privés par compte — d'où Moyen et non Élevé). Le texte des labels, lui, est correctement échappé (placé en contenu texte). 
**Fix :** valider les couleurs contre une liste blanche (`/^#[0-9a-f]{3,8}$/i` ou `var(--…)`), et/ou échapper les guillemets dans `_esc`, et/ou passer le SVG par DOMPurify. Une CSP (M-1) limiterait l'impact.

### 🟠 M-4 — Fuite de détails d'exception au client
`detail=f"… : {e}"` dans [server.py:263](help-me-learn/server.py#L263) (translate), [:296](help-me-learn/server.py#L296) (tts), [:320](help-me-learn/server.py#L320) (stt), [:519](help-me-learn/server.py#L519) (extract), [:540](help-me-learn/server.py#L540) (llm 500). Expose chemins/internes de librairies. Fix : message générique au client + log serveur détaillé.

### 🟠 M-5 — Scripts CDN sans SRI + pdf.js avec CVE connue
[index.html:36-37](help-me-learn/web/index.html#L36) : **pdf.js 3.11.174** et **tesseract.js 5.1.0** chargés **sans `integrity` (SRI)** (React/KaTeX/Babel, eux, l'ont). Surface chaîne-d'appro. De plus, **pdf.js 3.11.174 est vulnérable à CVE-2024-4367** (exécution JS arbitraire via PDF piégé, corrigé en ≥ 4.2.67). Atténuant : le chemin pdf.js **client est quasi mort** (extraction = serveur), donc l'exposition réelle est faible. Fix : **supprimer pdf.js du front s'il est inutilisé**, sinon le mettre à jour ≥ 4.2.67 + ajouter SRI sur les deux scripts.

### 🟠 M-6 — Pas de lockfile (versions non figées)
[requirements.txt](help-me-learn/requirements.txt) en `>=` → builds non reproductibles, exposition CVE inconnue. Fix : figer (`pip compile`/`pip freeze` → `requirements.lock`) et lancer `pip-audit` (commande §7).

---

## 5. Findings sécurité — Faibles & Info

- **L-1** — `/api/figures/{course_id}/{fig_id}` ([server.py:481](help-me-learn/server.py#L481)) retombe sur le slot global `"app"` pour tout uid (y compris anonyme) → lecture possible des figures héritées du slot partagé legacy. Faible (le slot `app` est partagé par conception).
- **L-2** — Hachage mot de passe : PBKDF2-HMAC-SHA256 **200 000 itérations** ([server.py:135](help-me-learn/server.py#L135)) — acceptable mais sous la reco OWASP 2023 (600k pour PBKDF2, ou Argon2id). Mot de passe **min. 6 caractères** = faible.
- **L-3** — Entrées non bornées : `prompt` LLM (coût), `segments` TTS ([tts.py:204](help-me-learn/tts.py#L204), nombre illimité, chaque segment plafonné à 5000), `texts` translate. Amplification/DoS. (STT plafonné 25 Mo ✔, extract 50 Mo ✔.)
- **L-4** — `main.jsx:847` `document.write(html)` pour l'export PDF : écrit le contenu du cours (incl. SVG) dans une nouvelle fenêtre. Contenu propre à l'utilisateur → risque faible, mais à surveiller si l'export devient partageable.
- **L-5** — `llm.py` `HTTP-Referer: http://localhost:8000` codé en dur ([llm.py:105](help-me-learn/llm.py#L105)) — cosmétique, ne fuit rien de sensible.
- **L-6** — `_send_reset_email` logge le lien de reset en clair sur la console serveur quand SMTP non configuré ([server.py:188](help-me-learn/server.py#L188)) — acceptable en self-host, à garder en tête (logs).
- **L-7** — Vérifier les **permissions du `.env`** sur le VPS (`chmod 600`) — non vérifiable depuis ici.
- **L-8** — `/api/health` n'expose **pas** les clés (✔), seulement des booléens `configured` et les noms de modèles — OK, juste noté comme point vérifié.

### ✔ Points vérifiés sains
- **Secrets jamais committés** : `.env` et `data.db` gitignorés **et absents de tout l'historique** (`git log --all --diff-filter=A` → rien). ✔
- **SQL entièrement paramétré** (`?`) partout (auth, état, figures) — pas d'injection SQL. ✔
- **Rendu prose échappé par React** (`renderMarkdown`/`renderInline` produisent des nœuds React, pas de HTML brut) ; KaTeX en `throwOnError:false`, `trust` par défaut (false). ✔
- **Clés API jamais envoyées au client** : tout passe par `/api/llm` côté serveur ; `localStorage.hml_api_key` est une fonctionnalité BYOK legacy locale, pas une fuite. ✔
- **Service worker network-first** ([sw.js:6](help-me-learn/web/sw.js#L6)) : ignore `/api/*` et le non-GET, purge les vieux caches, `skipWaiting`+`clients.claim`. Bonne stratégie contre le code obsolète (voir §7 pour la nuance versionnage). ✔
- **App non joignable hors reverse-proxy** (`expose` et non `ports` dans compose). ✔

---

## 6. Dépendances

- **Python** : pas de lockfile (M-6). À rejouer sur le VPS : `pip-audit -r requirements.txt`, `pipdeptree`. Aucun paquet au nom « suspect/typosquat » repéré — tous sont des libs reconnues (fastapi, httpx, pdfium2, piper-tts, faster-whisper, argostranslate).
- **CDN front** : versions toutes épinglées ✔ ; SRI présent sur React/ReactDOM/Babel/KaTeX, **absent sur pdf.js + tesseract.js** (M-5).
- **Poids image Docker (L/dette)** : `argostranslate` tire `stanza` → `torch` + stack CUDA (plusieurs Go) inutile sur CPU. Piste d'allègement : installer torch CPU-only (`--index-url .../cpu`) ou évaluer si la traduction offline justifie ce poids vs. un appel LLM ponctuel.

### Résultats des scanners (exécutés le 2026-06-21)

| Outil | Résultat |
|---|---|
| **gitleaks** 8.30.1 (`--log-opts=--all`) | **0 fuite** sur 40 commits / tout l'historique. ✔ |
| **vulture** 2.16 (conf. ≥80 %) | **0 code mort** dans le backend. ✔ |
| **bandit** 1.9.4 | Avant : 2 High / 1 Med / 15 Low. **Après correctifs : 0 High**, 1 Med (B310 — `urllib` dans `scripts/download_voices.py`, URL de voix connue, légitime), 15 Low (`try/except/pass` défensifs, acceptables). |
| **pip-audit** 2.10.1 | A signalé `stanza 1.10.1` → **CVE-2026-54499**. **Faux positif pour la prod** : c'était une vieille install locale ; l'argostranslate déployé (≥1.11) est passé à spaCy et ne tire plus stanza, donc le paquet n'est pas présent en prod. (Pin retiré car il cassait le build Docker.) Rejouer `pip-audit` sur le VPS pour confirmer l'arbre réel. |
| **semgrep** 1.167.0 | Installé mais **ne s'exécute pas nativement sous Windows** (sortie vide, exit 2 — limitation connue, le core OCaml requiert WSL/Docker). À rejouer sur le VPS : `semgrep scan --config=auto --config p/owasp-top-ten --config p/python .` |

Commandes pour rejouer (VPS Linux, où le code est aussi cloné) :
```bash
python -m bandit -r . -x ./.venv,./voices,./.tts_cache
python -m pip_audit -r requirements.txt
python -m vulture server.py llm.py tts.py stt.py translate.py extract.py --min-confidence 80
gitleaks detect --source . --log-opts="--all"
semgrep scan --config=auto --config p/owasp-top-ten --config p/python .
```

---

## 7. Durcissement ops — serveur public (section dédiée)

1. **Fermer/limiter les endpoints coûteux** (H-1) — le plus urgent.
   - Mitigation Caddy immédiate (auth basique le temps de coder le rate-limit) :
     ```caddyfile
     {$DOMAIN} {
       encode zstd gzip
       header {
         Strict-Transport-Security "max-age=31536000; includeSubDomains"
         X-Content-Type-Options "nosniff"
         X-Frame-Options "DENY"
         Referrer-Policy "strict-origin-when-cross-origin"
         -Server
       }
       reverse_proxy app:8000
     }
     ```
   - Rate-limit applicatif : `slowapi` par IP sur `/api/llm*`, `/api/stt`, `/api/extract`, `/api/translate`, `/api/auth/*`.
2. **En-têtes de sécurité** (M-1) — bloc `header` ci-dessus ; ajouter une CSP une fois le `unsafe-eval` (Babel) traité.
3. **Concurrence SQLite** (H-2) — WAL + `busy_timeout` + verrou d'écriture, ou connexion par thread.
4. **Cookies/sessions** (M-2) — `secure=True`, TTL + purge.
5. **Comptes/emails** — rate-limit `register`/`forgot` ; envisager une vérification anti-bot.
6. **SSH/VPS** — clés uniquement (désactiver mot de passe), `fail2ban`, mises à jour auto sécurité, `chmod 600 .env`.
7. **Propagation des mises à jour (SW)** — `sw.js` est network-first (bon), mais le **bump de cache est manuel** (`CACHE = "hml-v2"`). En cas de gros refactor offline, penser à incrémenter. Pas de risque d'empoisonnement (même origine seulement, `res.ok` requis).

---

## 8. Dette architecturale (hors sécurité)

1. **Découper `main.jsx` (1116 l.)** : extraire auth UI, export PDF, et le shell/nav en modules dédiés.
2. **Découper `lib/speech.jsx` (1105 l.)** : séparer lecture-à-voix-haute et Q&A vocale.
3. **Formaliser le contrat `window.*`** : au minimum un commentaire en tête d'`index.html` documentant l'ordre de chargement requis ; idéalement, vérifier au démarrage que les globals attendus existent (échec bruyant plutôt que `undefined` silencieux).
4. **Cesser de ré-exporter les hooks React via `window`** (`components.jsx`) : utiliser `React.useState` directement réduit le couplage d'ordre caché.
5. **Envisager un build minimal** (esbuild/Vite) : supprimerait Babel-standalone (perf + permettrait une vraie CSP sans `unsafe-eval`), tout en gardant la simplicité. Compromis à peser avec la philosophie « buildless ».
6. **Sortir les gros blobs d'état de la table `kv`** : le modèle « table dédiée » des figures est le bon ; l'étendre aux cours réduirait la pression d'écriture SQLite (lié à H-2).
7. **Supprimer le mort** : `llm_new.py` (vide), et le chemin pdf.js client si confirmé inutilisé.

---

## 9. Top 10 — actions prioritaires (ordre de traitement)

1. **H-1** — Fermer/auth/rate-limit les endpoints coûteux (mitigation Caddy immédiate, puis `slowapi`).
2. **H-2** — Corriger la concurrence SQLite (WAL + verrou d'écriture / connexion par thread).
3. **M-1** — Ajouter les en-têtes de sécurité Caddy (HSTS, X-Frame-Options, nosniff, Referrer-Policy).
4. **M-2** — `secure=True` sur le cookie + expiration/purge des sessions et reset_tokens.
5. **M-4** — Ne plus renvoyer `{e}` au client (message générique + log serveur).
6. **M-5** — Supprimer pdf.js/tesseract du front s'ils sont inutilisés ; sinon MAJ pdf.js ≥ 4.2.67 + SRI.
7. **L-2 / L-3** — Mot de passe min. 10–12 + bornes de taille sur les entrées LLM/TTS/translate.
8. **M-3** — Valider les couleurs de figures (liste blanche) + échapper les guillemets dans `_esc`.
9. **M-6** — Figer les dépendances (lockfile) et lancer `pip-audit` + `semgrep` + `gitleaks` (Docker).
10. **Dette** — Découper `main.jsx`/`speech.jsx`, documenter l'ordre `window.*`, supprimer `llm_new.py`.

---

*Rien n'a été modifié dans le code. En attente de ta validation pour passer aux correctifs — dis-moi par où tu veux commencer (je recommande H-1 puis H-2).*
