# Architecture

## High-level flow

```
Browser SPA  →  Express REST API  →  Local storage (data/, SQLite, JSON)
                      ↓
              Android Phone (ADB)
                      ↓
              Zone crop + AI analysis  →  Gemini / Claude API
                      ↓
              Analytics, charts, JSON export
```

## Components

### Frontend (`public/`)

- Vanilla JavaScript single-page app (no React/Vue lock-in)
- Glassmorphism UI with Chart.js for analytics
- Tab-based navigation: Settings, Phone, Recording, Zones, Gallery, Processing, Analytics, Trash
- Standalone pages: `start-recording.html` (recording launcher), `project-board.html` (task tracking)

### Backend (`server/`)

- **Express 5** REST API
- **SQLite** (`better-sqlite3`) — settings, API usage logs, phone health history
- **Sharp** — image rotation and zone cropping
- **ADB integration** — remote camera control and device health via `dumpsys`

### Storage

| Location | Contents |
|----------|----------|
| `data/` | Meal photos, videos, recording session folders |
| `db/dininglens.db` | Settings, phone health samples, API usage |
| `processed/results.json` | Cached AI analysis results |
| `captures/` | One-shot phone snaps |

### External services

- **Google Gemini** or **Anthropic Claude** for vision analysis only
- No proprietary DiningLens backend — you bring your own API key

## Privacy model

| Data | Where it lives |
|------|----------------|
| Meal photos | Local `data/` folder |
| Analysis results | Local JSON + optional export |
| Settings & device history | Local SQLite |
| Images sent to AI | Your chosen provider (Gemini/Claude) only |

Ideal for IRB-constrained environments where imagery must remain on-premises while still using state-of-the-art vision models.

## Project layout

```
DiningLens/
├── server/              Express backend, routes, AI integration, ADB
├── public/              Frontend SPA and standalone HTML pages
├── data/                Meal photos and recordings (gitignored)
├── db/                  SQLite database (gitignored)
├── processed/           Cached AI results
├── scripts/             CLI tools (e.g. meal analysis diagnostic)
├── Presentation/        Project presentation deck
└── docs/wiki/           This wiki (source for GitHub Wiki)
```
