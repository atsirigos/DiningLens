# Features

DiningLens has **nine integrated modules** in the main app, plus standalone utilities.

## ⚙️ Settings

- Choose AI provider (Gemini or Anthropic)
- Configure model and API key
- Track API usage and estimated cost per call

## 📱 Phone Configuration

- Register Android devices (USB or Wi-Fi ADB)
- Pair and connect over wireless debugging
- Configure DCIM path, shutter keycodes, frame rotation
- Auto-install platform-tools if ADB is missing
- Battery charge control (80%/20% thresholds for long deployments)

## 🔋 Phone Status

- Live battery %, temperature, storage, GPS
- Color-coded health thresholds (safe / caution / critical)
- Historical charts stored in SQLite
- Configurable refresh interval (manual to every 60 seconds)

## 🔴 Recording

- **Scheduled timelapse capture** via ADB (JPEG frames, not browser video)
- Configurable interval (5–600 sec) and max duration (1–240 min)
- Frames saved to `data/recordings/<session-id>/`
- Frame-by-frame playback in Gallery
- Server-side capture loop continues if the browser tab is closed
- Standalone launcher: [`start-recording.html`](../../public/start-recording.html) + `start-recording.bat`

## 📐 Zones

- Draw named regions on a reference photo
- Same layout applies to every image from a fixed camera
- Enables **multi-subject analysis** from one overhead shot
- Zone overlays visible in Gallery lightbox

## 🖼️ Gallery

- Browse images, videos, and recording sessions
- Filters, lightbox, zone overlays
- Inline AI results per frame; link to Processing tab
- Recording playback scrubber with adjustable speed

## 🗑️ Trash

- Soft delete with restore
- Permanent purge when ready

## ⚡ Processing

- Analyze single photos or batch-process all
- Optional user context ("half portion eaten")
- Zone-aware: crops each region and merges results
- Per-frame processing from recording lightbox

## 📊 Analytics

- Food frequency and calorie charts
- Export all results as `dininglens-results.json`

## Standalone utilities

| File | Purpose |
|------|---------|
| `start-recording.bat` | Start server if needed, open recording page |
| `start-server.bat` | Start dev server with LAN URL list |
| `project-board.html` | Browser-based task board (localStorage) |
| `npm run diagnose` | Preflight + live API test on `data/` images |
