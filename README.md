# SmartDining

A local-only web app that reads meal photos from a `data/` folder, runs AI analysis via the Gemini API, and generates meal analytics. No cloud uploads. All data stays on your machine in a local SQLite database and JSON cache files.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set your API key for the provider you use (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`), or configure it in the Settings UI.

3. **Add meal photos**
   Drop images (`.jpg`, `.png`, `.webp`) or videos (`.mp4`, `.mov`) into the `data/` folder.

4. **Start the dev server** (auto-restarts on file changes)
   ```bash
   npm run dev
   ```

5. **Diagnose meal analysis** (preflight + live API test on `data/` images)
   ```bash
   npm run diagnose
   npm run diagnose -- --file 20260425_134151.jpg --verbose
   npm run diagnose -- --dry-run
   ```

6. Open [http://localhost:3000](http://localhost:3000)

## Project board

Open [`project-board.html`](project-board.html) in your browser for standalone task tracking (priorities, due dates, status). Tasks persist in **browser localStorage** — separate from the app's SQLite database.

## Usage

1. **Settings** — Configure AI provider, model, and API key.
2. **Zones** — Draw named zones on a reference photo; the same layout applies to every photo from your fixed camera.
3. **Gallery** — Browse all files in `data/` with filters and a full-screen lightbox (zone overlays when configured).
4. **Processing** — Run AI analysis on individual photos or batch-process all.
5. **Analytics** — View charts for food frequency, calories, and export results.

## Project Structure

```
SmartDining/
├── server/          Express backend + Gemini integration
├── public/          Frontend SPA (HTML/CSS/JS)
├── data/            Your meal photos (not tracked in git)
├── db/              Local SQLite database (settings)
├── processed/       Cached AI results (results.json)
└── .env             Optional fallback API key (not tracked in git)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files` | List all files in `data/` |
| GET | `/api/file/:name` | Stream a file |
| GET/POST | `/api/settings` | Read/write settings |
| POST | `/api/process` | Analyze an image with Gemini |
| DELETE | `/api/process/:name` | Clear cached result |
| GET | `/api/results` | All cached analysis results |

## Requirements

- Node.js 18+
- A [Google Gemini](https://aistudio.google.com/apikey) or [Anthropic](https://console.anthropic.com/) API key
