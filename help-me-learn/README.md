# Help me Learn — version 100% locale

Toute l'application tourne **sur ta machine** :

- **Extraction des PDF** → [`pdf_oxide`](https://github.com/yfedoseev/pdf_oxide) (texte/markdown haute-fidélité) + `pypdfium2` (rendu, images intégrées, diagrammes vectoriels). Pipeline hybride : il ne rate plus ni les photos intégrées, ni les diagrammes dessinés, et garde les encadrés colorés comme **texte** (pas comme image).
- **Rédaction des leçons** → au choix **Gemini 2.5 Flash** (API gratuite, meilleur raisonnement + multimodal natif, **recommandé**), **Claude** (ta clé API, qualité premium), ou ~~Ollama~~ (déprécié). Tu changes de moteur en un clic dans l'app.

L'interface est exactement celle que tu connais (les 11 sections, quiz, flashcards, plan 40 jours, bibliothèque).

---

## 1. Prérequis

- **Python 3.9+** (vérifie : `python3 --version`)
- **Une clé Gemini** (gratuite, recommandée) — https://ai.google.dev — ou
- **Une clé Claude** (payante, pour qualité premium) — https://console.anthropic.com

---

## 2. Installation

```bash
cd helpme-learn-local

# (recommandé) un environnement isolé
python3 -m venv .venv
source .venv/bin/activate          # Windows : .venv\Scripts\activate

pip install -r requirements.txt
```

---

## 3. Configuration

Copie `.env.example` en `.env` et renseigne ta(tes) clé(s) API :

```bash
cp .env.example .env
```

```ini
# .env — Gemini (recommandé, gratuit)
GOOGLE_API_KEY=AIzaSy...           # https://ai.google.dev/
GOOGLE_MODEL=gemini-2.5-flash

# .env — Claude (optionnel, payant mais meilleure qualité)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Moteur par défaut au lancement : gemini | claude
DEFAULT_PROVIDER=gemini
```

> Les clés restent **dans ce fichier sur ta machine** : elles ne touchent jamais le navigateur.

---

## 4. Lancer

```bash
# Lance le serveur Python (Gemini/Claude sont cloud-based, pas besoin de lancer localement)
python server.py
```

Ouvre **http://localhost:8000** dans ton navigateur.

Dans l'app : bouton **« Moteur »** (en bas à gauche) → choisis **Gemini**, **Claude**, ou les deux. Le choix est mémorisé.

---

## 4. Comparaison des moteurs

| Moteur | Coût | Raisonnement | Vision | Latence | Mode |
|--------|------|------------|--------|---------|------|
| **Gemini 2.5** | ✅ Gratuit (1500 req/jour) | ⭐⭐⭐⭐ | ✅ Natif | ~2-5s | Cloud |
| **Claude** | 💰 Payant | ⭐⭐⭐⭐⭐ | ❌ Non (texte only) | ~1-3s | Cloud |
| ~~Ollama~~ | ✅ Gratuit | ⭐⭐ | ❌ | Variable | Local |

**Recommandation** : Commence avec **Gemini** (gratuit, bon ratio qualité/coût). Si tu veux la meilleure qualité pédagogique, bascule sur **Claude**.

---

## 5. Comment ça marche (architecture)

```
helpme-learn-local/
├── server.py        FastAPI : sert l'UI + /api/extract + /api/llm + /api/health
├── extract.py       Extraction hybride PDF (pdf_oxide + pypdfium2 + analyse de mise en page)
├── llm.py           Routeur LLM : Gemini (API gratuite) ou Claude (API payante)
├── requirements.txt
├── .env.example
└── web/             L'interface (identique, mais extraction + IA passent par le serveur)
```

- `POST /api/extract` (PDF) → `{ text, pages, truncated, images:[{id,page,w,h,url}] }`
  - **Texte** : `pdf_oxide.to_markdown` (ordre de lecture, titres, tableaux).
  - **Images raster** : bounding boxes des objets-image du PDF (via pdfium) → jamais manquées.
  - **Diagrammes vectoriels** : rendu de la page → grille d'encre **moins** le texte **moins** les images → composantes connexes → recadrage. Les blocs trop denses en texte (encadrés colorés) sont **gardés comme texte**.
  - Un marqueur `[[FIG:fN]]` est inséré à la position de lecture de chaque figure ; l'IA réinsère la vraie image au bon endroit.
- `POST /api/llm` `{ system, prompt, provider, model }` → `{ text }` (Gemini ou Claude).

---

## 6. Réglages de l'extraction

Dans `extract.py`, en haut, quelques curseurs sûrs à ajuster si besoin :

| Réglage | Effet |
|---|---|
| `RENDER_SCALE` | Netteté des images extraites (2.0 ≈ 144 dpi). Monte à 3.0 pour plus de détail. |
| `MIN_FIG_FRAC_W/H` | Taille minimale d'une figure (en % de la page). Baisse pour capter de petits schémas. |
| `TEXTBOX_CHAR_COV` | Seuil texte/figure. **Monte-le** (ex. 0.22) si des encadrés colorés sont pris pour des images ; **baisse-le** si un diagramme avec beaucoup de labels est ignoré. |
| `MAX_PAGES`, `FIG_CAP` | Limites de pages et d'images par document. |

---

## 7. Dépannage

- **« Le serveur local ne répond pas »** → `python server.py` n'est pas lancé, ou pas sur le port 8000.
- **« Aucune clé Gemini configurée »** → va sur https://ai.google.dev/, crée une clé gratuite, ajoute `GOOGLE_API_KEY` dans `.env` puis relance le serveur.
- **« Limite Gemini atteinte (1500 req/jour) »** → Bascule sur Claude, ou réessaie demain. (Astuce : optimise tes prompts pour réduire les appels.)
- **« Erreur 401 — clé Gemini invalide »** → Vérifie que tu as copié la bonne clé depuis https://ai.google.dev/. Relance le serveur.
- **« Erreur 429 — trop de requêtes »** → Attends quelques secondes avant de réessayer. Avec le plan gratuit, respecte les limites : max 1500 requêtes par jour.
- **« Aucune clé Claude configurée »** → ajoute `ANTHROPIC_API_KEY` dans `.env` puis relance le serveur (optionnel, pour qualité supérieure).
- **L'UI ne se charge pas hors-ligne la 1ʳᵉ fois** → React/Babel/KaTeX sont chargés depuis un CDN au premier lancement puis mis en cache. Pour un offline total, on peut « vendoriser » ces fichiers dans `web/` (demande-moi).

---

## 8. Test rapide de l'extracteur (sans l'UI)

```bash
python -c "from extract import extract_pdf; r=extract_pdf(open('mon_cours.pdf','rb').read()); print('pages:',r['pages'],'| images:',len(r['images'])); print(r['text'][:800])"
```
