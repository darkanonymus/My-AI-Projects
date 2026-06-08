# Help me Learn — fully local edition

The whole app runs **on your machine**:

- **PDF extraction** → [`pdf_oxide`](https://github.com/yfedoseev/pdf_oxide) (high-fidelity text/markdown) + `pypdfium2` (rendering, embedded images, vector diagrams). A hybrid pipeline that no longer misses embedded photos or hand-drawn diagrams, and keeps colored callout boxes as **text** (not as images).
- **Lesson writing** → your choice of **Gemini 2.5 Flash** (free API, best reasoning + native multimodal, **recommended**), **Claude** (your own API key, premium quality), or ~~Ollama~~ (deprecated). Switch engines with one click in the app.

## Features

- **Lessons in 11 structured sections**, generated from any course text, exercise sheet, PDF, or image (German source material accepted) — with progress tracking, glossary, "to verify" notes, and a suggested next step.
- **In-lesson contextual Q&A** — select any passage of a lesson to ask a question about it, request a simpler example, or send it straight to the quiz/flashcard bank. The AI grounds its answer in the source material first and clearly labels whether the answer comes from the course or from broader knowledge. Answers can be inserted inline (and removed later) without ever touching the original lesson text.
- **Hide passages you don't need** — select one or more paragraphs and collapse them into a placeholder bar with **Show** (temporary, session-only) and **Restore** (permanent) actions. The underlying lesson markdown is never modified — exactly like the Q&A insertions, hiding is fully non-destructive and reversible.
- **Quiz, flashcards, and a 40-day study plan** generated from your lessons, with duplicate-detection so the AI won't add a card or question that already covers the same idea.
- **Library** — every course is saved automatically; open, review, mark as mastered, or download any of them as a standalone HTML file at any time.

The interface is the one you already know (the 11 sections, quiz, flashcards, 40-day plan, library) — it now also runs your text extraction and AI calls through a local server instead of the browser.

---

## 1. Requirements

- **Python 3.9+** (check with `python3 --version`)
- **A Gemini API key** (free, recommended) — https://ai.google.dev — or
- **A Claude API key** (paid, for premium quality) — https://console.anthropic.com

---

## 2. Installation

```bash
cd helpme-learn-local

# (recommended) an isolated environment
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt
```

---

## 3. Configuration

Copy `.env.example` to `.env` and fill in your API key(s):

```bash
cp .env.example .env
```

```ini
# .env — Gemini (recommended, free)
GOOGLE_API_KEY=AIzaSy...           # https://ai.google.dev/
GOOGLE_MODEL=gemini-2.5-flash

# .env — Claude (optional, paid but higher quality)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Default engine on launch: gemini | claude
DEFAULT_PROVIDER=gemini
```

> Your keys stay **in this file, on your machine** — they never reach the browser.

---

## 4. Run it

```bash
# Start the Python server (Gemini/Claude are cloud-based, nothing else to run locally)
python server.py
```

Open **http://localhost:8000** in your browser.

In the app: the **"Engine"** button (bottom left) lets you pick **Gemini**, **Claude**, or both. Your choice is remembered.

---

## 4. Engine comparison

| Engine | Cost | Reasoning | Vision | Latency | Mode |
|--------|------|-----------|--------|---------|------|
| **Gemini 2.5** | ✅ Free (1500 req/day) | ⭐⭐⭐⭐ | ✅ Native | ~2-5s | Cloud |
| **Claude** | 💰 Paid | ⭐⭐⭐⭐⭐ | ❌ No (text only) | ~1-3s | Cloud |
| ~~Ollama~~ | ✅ Free | ⭐⭐ | ❌ | Variable | Local |

**Recommendation**: Start with **Gemini** (free, good quality/cost ratio). If you want the best pedagogical quality, switch to **Claude**.

---

## 5. How it works (architecture)

```
helpme-learn-local/
├── server.py        FastAPI: serves the UI + /api/extract + /api/llm + /api/health
├── extract.py       Hybrid PDF extraction (pdf_oxide + pypdfium2 + layout analysis)
├── llm.py           LLM router: Gemini (free API) or Claude (paid API)
├── requirements.txt
├── .env.example
└── web/             The interface (same as before, but extraction + AI now go through the server)
```

- `POST /api/extract` (PDF) → `{ text, pages, truncated, images:[{id,page,w,h,url}] }`
  - **Text**: `pdf_oxide.to_markdown` (reading order, headings, tables).
  - **Raster images**: bounding boxes of the PDF's image objects (via pdfium) → never missed.
  - **Vector diagrams**: page render → ink grid **minus** text **minus** images → connected components → cropping. Text-dense blocks (colored callout boxes) are **kept as text**.
  - A `[[FIG:fN]]` marker is inserted at each figure's reading position; the AI re-inserts the actual image at the right spot.
- `POST /api/llm` `{ system, prompt, provider, model }` → `{ text }` (Gemini or Claude).

---

## 6. Extraction settings

At the top of `extract.py`, a few safe knobs you can tune if needed:

| Setting | Effect |
|---|---|
| `RENDER_SCALE` | Sharpness of extracted images (2.0 ≈ 144 dpi). Raise to 3.0 for more detail. |
| `MIN_FIG_FRAC_W/H` | Minimum size of a figure (as % of the page). Lower it to catch small diagrams. |
| `TEXTBOX_CHAR_COV` | Text-vs-figure threshold. **Raise it** (e.g. 0.22) if colored callout boxes get mistaken for images; **lower it** if a diagram with lots of labels gets ignored. |
| `MAX_PAGES`, `FIG_CAP` | Page and per-document image limits. |

---

## 7. Troubleshooting

- **"The local server isn't responding"** → `python server.py` isn't running, or not on port 8000.
- **"No Gemini key configured"** → go to https://ai.google.dev/, create a free key, add `GOOGLE_API_KEY` to `.env`, then restart the server.
- **"Gemini quota reached (1500 req/day)"** → switch to Claude, or try again tomorrow. (Tip: tighten your prompts to use fewer calls.)
- **"Error 401 — invalid Gemini key"** → make sure you copied the right key from https://ai.google.dev/. Restart the server.
- **"Error 429 — too many requests"** → wait a few seconds before retrying. On the free plan, stay under 1500 requests/day.
- **"No Claude key configured"** → add `ANTHROPIC_API_KEY` to `.env` then restart the server (optional, for higher quality).
- **The UI doesn't load offline on first launch** → React/Babel/KaTeX are loaded from a CDN on first run, then cached. For full offline use, these files can be vendored into `web/` (just ask).

---

## 8. Quick extractor test (without the UI)

```bash
python -c "from extract import extract_pdf; r=extract_pdf(open('my_course.pdf','rb').read()); print('pages:',r['pages'],'| images:',len(r['images'])); print(r['text'][:800])"
```
