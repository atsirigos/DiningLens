# Getting Started

## Requirements

- **Node.js 18+**
- **Google Gemini** or **Anthropic** API key ([Gemini](https://aistudio.google.com/apikey) · [Anthropic](https://console.anthropic.com/))
- (Optional) Android phone with Developer Options for ADB capture

## Installation

```bash
git clone https://github.com/atsirigos/DiningLens.git
cd DiningLens
npm install
cp .env.example .env
```

Edit `.env`:

```
GEMINI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
PORT=3000
```

You can also set the API key in the Settings UI after launch.

## Start the server

**Option A — Development (auto-reload via nodemon)**

```bash
npm run dev
```

**Option B — Windows batch launchers**

| Script | What it does |
|--------|----------------|
| `start-server.bat` | Starts server, prints LAN URLs |
| `start-recording.bat` | Starts server if down, opens recording page |

## Add meal photos

Drop files into `data/`:

- Images: `.jpg`, `.jpeg`, `.png`, `.webp`
- Videos: `.mp4`, `.mov` (manual drop; playable in Gallery)

Or use Phone Configuration / Recording to capture from an Android device.

## Open the app

[http://localhost:3000](http://localhost:3000)

From another device on your network, use your PC's LAN IP: `http://192.168.x.x:3000`

## Diagnostic tool

Preflight checks + live API test on images in `data/`:

```bash
npm run diagnose
npm run diagnose -- --file photo.jpg --verbose
npm run diagnose -- --dry-run
```

## Typical workflow

1. **Settings** — set provider and API key
2. **Phone Configuration** — connect Android device (if using remote capture)
3. **Zones** — define table regions (optional, for multi-subject setups)
4. **Recording** or file drop — collect meal photos
5. **Processing** — run AI analysis
6. **Analytics** — review charts and export JSON

## Troubleshooting

| Issue | Check |
|-------|-------|
| Server won't start | Node 18+, `npm install`, port 3000 free |
| AI analysis fails | API key in Settings or `.env`, image under 20 MB |
| Phone not found | ADB installed, wireless debugging paired, same Wi-Fi |
| Recording won't start | Active device selected and connected in Phone Configuration |
