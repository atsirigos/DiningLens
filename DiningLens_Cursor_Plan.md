# DiningLens Local Web App — Cursor Build Plan

> Paste this file into your Cursor project root as `CURSOR_PLAN.md`.
> Work through phases in order. Each phase ends with a checkpoint before moving on.

---

## 🗂️ Project Summary

A **local-only** web app that reads photos/videos from a `Data/` folder, runs AI analysis on food images, and generates meal analytics. No cloud uploads. No database. All data stays on your machine.

**Stack:** Node.js (Express) · Vanilla JS (ES6 modules) · HTML/CSS (Glassmorphism) · Chart.js · Gemini API

---

## 📁 Target Folder Structure

```
DiningLens-WebApp/
├── server/
│   ├── server.js              # Express entry point
│   ├── routes/
│   │   ├── files.js           # /api/files, /api/file/:name
│   │   └── process.js         # /api/process
│   └── utils/
│       ├── fileScanner.js     # Reads Data/ directory
│       └── aiWrapper.js       # Gemini API call + caching
│
├── public/
│   ├── index.html             # Single-page shell
│   ├── styles/
│   │   ├── main.css           # Global resets, CSS variables
│   │   ├── glass.css          # Glassmorphism components
│   │   └── layout.css         # Sidebar + page layout
│   ├── scripts/
│   │   ├── app.js             # Router / tab switcher
│   │   ├── gallery.js         # Gallery page logic
│   │   ├── settings.js        # Settings page logic
│   │   ├── processing.js      # Processing page logic
│   │   └── analytics.js       # Analytics page logic
│   ├── components/
│   │   ├── sidebar.html       # Nav sidebar snippet
│   │   ├── modal.html         # Reusable modal
│   │   └── toast.html         # Notification toasts
│   └── assets/
│       └── icons/             # SVG icons
│
├── Data/                      # ← Drop your images/videos here
│
├── processed/
│   └── results.json           # Cached AI analysis output
│
├── settings.json              # User-defined zones + config
├── package.json
└── CURSOR_PLAN.md             # This file
```

---

## 🚦 Build Phases

---

### Phase 1 — Project Scaffold

**Goal:** Get a running local server with the correct folder structure.

#### Tasks

1. Run `npm init -y` in the project root.
2. Install dependencies:
   ```bash
   npm install express cors multer dotenv
   ```
3. Create `server/server.js`:
   - Serve `public/` as static files.
   - Mount routes from `server/routes/`.
   - Listen on `http://localhost:3000`.
4. Create all empty folders and placeholder files listed in the structure above.
5. Create a `.env` file with:
   ```
   GEMINI_API_KEY=your_key_here
   PORT=3000
   ```
6. Add a `start` script to `package.json`: `"start": "node server/server.js"`.

#### Checkpoint
- `npm start` → server boots without errors.
- Visiting `http://localhost:3000` shows a blank page (no 404).

---

### Phase 2 — File API

**Goal:** Server can list and serve files from `Data/`.

#### Tasks

1. Implement `server/utils/fileScanner.js`:
   - Scans `Data/` recursively.
   - Returns an array of objects: `{ name, path, type, size, modified }`.
   - Supported types: `.jpg`, `.jpeg`, `.png`, `.webp`, `.mp4`, `.mov`.

2. Implement `server/routes/files.js`:
   - `GET /api/files` → returns JSON array from `fileScanner`.
   - `GET /api/file/:name` → streams the file from `Data/`.

3. Add CORS headers so the front end can call the API.

#### Checkpoint
- `GET http://localhost:3000/api/files` returns a JSON list of your `Data/` contents.
- Opening a file URL in the browser renders the image/video.

---

### Phase 3 — UI Shell

**Goal:** Full-page layout with sidebar navigation and four tab panels.

#### Tasks

1. Build `public/index.html`:
   - Single `<div id="app">` containing:
     - `<aside id="sidebar">` — navigation
     - `<main id="content">` — tab panels
   - Include `<script type="module" src="scripts/app.js">`.

2. Build `public/styles/main.css`:
   - CSS custom properties (design tokens):
     ```css
     --color-bg: #0f0f1a;
     --color-surface: rgba(255,255,255,0.07);
     --color-accent: #7c6ff7;
     --color-accent-2: #f76f9b;
     --color-text: #e8e8f0;
     --radius: 16px;
     --blur: blur(18px);
     ```
   - Dark background, fluid typography (`clamp()`).

3. Build `public/styles/glass.css`:
   - `.glass` class:
     ```css
     background: var(--color-surface);
     backdrop-filter: var(--blur);
     border: 1px solid rgba(255,255,255,0.12);
     border-radius: var(--radius);
     box-shadow: 0 8px 32px rgba(0,0,0,0.3);
     ```
   - `.btn-primary`, `.btn-ghost`, `.card`, `.badge`, `.toggle`.

4. Build `public/styles/layout.css`:
   - Sidebar: fixed left, 240px wide, full height.
   - Content: `margin-left: 240px`, padded.
   - Responsive: sidebar collapses to icon-only below 768px.

5. Build sidebar with four nav items (icons + labels):
   - ⚙️ Settings
   - 🖼️ Gallery
   - ⚡ Processing
   - 📊 Analytics

6. Build `public/scripts/app.js`:
   - Listens for sidebar nav clicks.
   - Shows/hides the correct `<section>` panel.
   - Highlights the active tab.
   - Loads each section's module on first activation (lazy).

#### Checkpoint
- All four tabs switch without page reload.
- Sidebar is visible and styled with the glass look.
- No console errors.

---

### Phase 4 — Gallery Page

**Goal:** Browse all `Data/` images and videos with metadata and full-screen preview.

#### Tasks

1. On Gallery tab activation, `gallery.js` calls `GET /api/files`.
2. Render a responsive CSS grid of thumbnail cards. Each card shows:
   - Thumbnail (image or video poster frame).
   - Filename (truncated).
   - File size and modification date.
   - A "Processed" badge if a result exists in `results.json`.
3. Implement filters:
   - Search bar (filters by filename).
   - Date range picker.
   - Toggle: Images only / Videos only / All.
4. Implement full-screen lightbox on card click:
   - Shows full image or `<video controls>`.
   - Overlaid panel on the right showing metadata + AI results (if available).
   - Keyboard nav: `←` / `→` arrows, `Esc` to close.

#### Checkpoint
- Gallery loads and displays all files from `Data/`.
- Filters narrow the grid in real time.
- Clicking any image opens the lightbox.

---

### Phase 5 — Settings Page

**Goal:** Allow users to define zones, seat layouts, and common foods, then save to `settings.json`.

#### Tasks

1. On Settings tab activation, `settings.js` loads `settings.json` (or defaults).
2. Build a **Zone Editor**:
   - Show a dropdown to pick any image from `Data/` as the reference frame.
   - Render that image on a `<canvas>`.
   - User can click-drag to draw named rectangular zones (e.g., "Seat 1 Plate", "Salad Bowl").
   - Zones are stored as `{ name, x, y, width, height }` relative to image dimensions (0–1 scale).
   - List of defined zones with rename + delete options.
3. Build a **Common Foods** editor:
   - Editable list of food labels (e.g., Salad, Bread, Water).
   - Add / remove entries.
4. Build a **Seat Layout** picker:
   - Preset options: 2-seat, 4-seat, 6-seat grid.
   - Or custom: user types number of seats.
5. Save button → `POST /api/settings` (or write directly to `settings.json` via server route).
6. Show a toast notification on save success.

#### New Server Route
- `GET /api/settings` → returns `settings.json`.
- `POST /api/settings` → writes body to `settings.json`.

#### Checkpoint
- Zones can be drawn on the canvas and saved.
- Reloading the app restores saved zones.
- Common foods list persists.

---

### Phase 6 — Processing Pipeline

**Goal:** Send images to Gemini API, extract food data, and cache results.

#### Tasks

1. Implement `server/utils/aiWrapper.js`:
   - Accepts a file path and zone config.
   - Reads the file, converts to base64.
   - Calls Gemini API with a structured prompt:
     ```
     Analyze this meal photo. For each defined zone, identify:
     - Food items present
     - Estimated ingredients
     - Approximate portion size (small / medium / large)
     Return JSON only. Schema: { zones: [{ name, foods: [{ item, ingredients, portion }] }] }
     ```
   - Returns parsed JSON.
   - Caches result in `processed/results.json` keyed by filename.

2. Implement `server/routes/process.js`:
   - `POST /api/process` — body: `{ filename }`.
   - Checks cache first; returns cached result if present.
   - Otherwise calls `aiWrapper`, stores result, returns it.
   - `DELETE /api/process/:name` — removes cached result so a file can be re-processed.

3. Build Processing UI in `processing.js`:
   - Shows a list of all files from `Data/`.
   - Each file shows status: Unprocessed / Processing / Done / Error.
   - "Process" button on each row.
   - "Process All" batch button with a progress bar.
   - On completion, display a summary panel: zones detected, food items found.

#### Checkpoint
- Clicking "Process" on one image returns AI results.
- Results persist after page reload.
- Re-processing works after deleting cache via the UI.

---

### Phase 7 — Analytics Dashboard

**Goal:** Visualize patterns across all processed results.

#### Tasks

1. On Analytics tab activation, `analytics.js` calls `GET /api/results` (returns all of `results.json`).
2. Compute aggregates client-side:
   - **Most frequent foods** (bar chart).
   - **Per-seat consumption breakdown** (grouped bar chart).
   - **Meal timeline** (line chart by date/time from file metadata).
   - **Ingredient frequency** (horizontal bar or word-cloud style list).
3. Render each chart in a `.glass` card using Chart.js:
   - Use the accent color palette (`#7c6ff7`, `#f76f9b`, `#6ff7c8`).
   - Animated on first load.
4. Add an **Export** button that downloads the full `results.json` as a file.
5. Add summary stat cards at the top: Total meals processed · Unique foods found · Most common item · Date range.

#### New Server Route
- `GET /api/results` → returns full `results.json`.

#### Checkpoint
- Charts render with real data from processed images.
- Export button downloads a valid JSON file.
- Stats cards show accurate numbers.

---

### Phase 8 — Polish & Hardening

**Goal:** Make the app feel complete and resilient.

#### Tasks

1. **Error handling:** Every API call has a try/catch. Failures show a toast, not a crash.
2. **Loading states:** Spinner or skeleton cards while data loads.
3. **Empty states:** Friendly messages when `Data/` is empty or no results yet.
4. **Keyboard accessibility:** Focus rings, `Escape` closes modals, arrow key nav in lightbox.
5. **Smooth transitions:** CSS `transition` on tab switches, card hovers, and modal open/close.
6. **Startup check:** On server boot, verify `Data/`, `processed/`, and `settings.json` exist; create them if not.
7. Add a README with setup instructions (copy `.env.example`, run `npm install`, run `npm start`).

---

## 🔑 Key Constraints (Do Not Violate)

| Rule | Detail |
|------|--------|
| Local only | No file is uploaded to any external service except the AI API (image bytes only) |
| No database | All persistence is via JSON files |
| Single-page | No page reloads; tab switching is client-side only |
| ES6 modules | Use `import`/`export`, not `require()`, in front-end scripts |
| API key safety | Key lives in `.env` only; never sent to the client or logged |
| Cache first | Always check `results.json` before calling the AI API |

---

## 🧪 Testing Checklist

Run through these after each phase:

- [ ] Server starts with `npm start` and no errors
- [ ] `GET /api/files` returns all files in `Data/`
- [ ] Gallery displays thumbnails for all files
- [ ] Lightbox opens and navigates correctly
- [ ] Zones can be drawn, named, and saved
- [ ] Settings reload correctly after browser refresh
- [ ] Processing returns valid JSON from Gemini
- [ ] Results persist after server restart
- [ ] Analytics charts render with real data
- [ ] Export downloads a valid JSON file
- [ ] App works on Chrome and Edge
- [ ] No API key visible in browser network tab

---

## 💡 Cursor Prompts (Copy-Paste Ready)

Use these prompts in Cursor chat to start each phase:

**Phase 1:**
> "Create the DiningLens folder structure and an Express server at server/server.js that serves public/ as static files and listens on port 3000."

**Phase 2:**
> "Build server/utils/fileScanner.js that scans the Data/ folder and returns an array of file metadata objects. Then create server/routes/files.js with GET /api/files and GET /api/file/:name."

**Phase 3:**
> "Build public/index.html with a sidebar and four tab panels (Settings, Gallery, Processing, Analytics). Style it with glassmorphism using dark backgrounds and frosted glass cards. Add public/scripts/app.js to handle tab switching."

**Phase 4:**
> "Build public/scripts/gallery.js. It should fetch /api/files, render a CSS grid of thumbnail cards, implement filename/date/type filters, and open a full-screen lightbox on click with keyboard navigation."

**Phase 5:**
> "Build public/scripts/settings.js with a canvas-based zone editor, a common foods list editor, and a seat layout picker. Add server routes GET /api/settings and POST /api/settings to read/write settings.json."

**Phase 6:**
> "Build server/utils/aiWrapper.js that converts an image to base64 and calls the Gemini API with a structured food-analysis prompt. Add POST /api/process and DELETE /api/process/:name routes. Then build public/scripts/processing.js with a queue UI and batch processing."

**Phase 7:**
> "Build public/scripts/analytics.js that reads all processed results, computes food frequency, per-seat breakdown, and meal timeline, then renders them as Chart.js charts inside glass cards with an export button."

**Phase 8:**
> "Add error handling toasts, loading skeletons, empty states, smooth CSS transitions, and a startup check that creates missing folders. Write a README.md with setup steps."
