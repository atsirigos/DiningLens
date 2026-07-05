# API Reference

Base URL: `http://localhost:3000/api`

All endpoints return JSON unless streaming a file. Errors return `{ "error": "message" }` with an appropriate HTTP status.

---

## Files

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/files` | List all files in `data/` (images, videos, recordings) |
| `GET` | `/file/*filepath` | Stream a file (supports nested paths like `recordings/session/frame.jpg`) |
| `POST` | `/files/rotate` | Rotate an image `{ path, degrees }` |
| `GET` | `/zone-crop` | Zone crop preview `?path=&zoneId=` |

---

## Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/settings` | Read all settings (AI provider, zones, phone config) |
| `POST` | `/settings` | Update settings (partial merge) |

---

## Processing

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/results` | All cached analysis results |
| `POST` | `/process` | Analyze an image `{ path, context? }` |
| `DELETE` | `/process/*filepath` | Clear cached result for a file |

---

## Phone

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/phone/status` | ADB availability, device list, active device |
| `GET` | `/phone/health` | Battery, temperature, storage, GPS (`?refreshIntervalSec=`) |
| `GET` | `/phone/history` | Health time series (`?limit=120`) |
| `DELETE` | `/phone/history` | Clear health history for active device |
| `POST` | `/phone/config` | Update phone settings (DCIM, keycodes, rotation, charge control) |
| `POST` | `/phone/devices` | Add a device |
| `DELETE` | `/phone/devices/:id` | Remove a device |
| `POST` | `/phone/active` | Set active device `{ deviceId }` |
| `POST` | `/phone/pair` | Wi-Fi ADB pair `{ address, code }` |
| `POST` | `/phone/connect` | Wi-Fi ADB connect `{ address }` |
| `POST` | `/phone/disconnect` | Disconnect Wi-Fi devices |
| `POST` | `/phone/install-adb` | Auto-install platform-tools |
| `POST` | `/camera/snap` | One-shot photo capture |

---

## Recording

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/recording/status` | — | Session state (`idle`, `recording`, `stopped`, `error`) |
| `POST` | `/recording/start` | `{ intervalSeconds, maxMinutes }` | Start timelapse capture |
| `POST` | `/recording/stop` | — | Stop and finalize session |

### Status response fields (when session exists)

| Field | Description |
|-------|-------------|
| `sessionId` | Folder name under `data/recordings/` |
| `framesCaptured` | Number of JPEGs pulled |
| `frames` | Array with `url` for each frame |
| `elapsedMs` / `remainingMs` | Session timing |
| `stopReason` | `manual`, `max_duration`, `too_many_failures` |
| `phoneCleanup` | Photos deleted, screen off status |

---

## Trash

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/trash` | List trashed items |
| `GET` | `/trash/file/*filepath` | Stream a trashed file |
| `POST` | `/trash` | Move to trash `{ path }` |
| `POST` | `/trash/restore` | Restore `{ path }` |
| `DELETE` | `/trash` | Empty trash |
| `DELETE` | `/trash/*filepath` | Permanently delete one item |

---

## Usage

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/usage` | API call log with cost estimates |
| `DELETE` | `/usage` | Clear usage log |

---

## Liveness checks

No dedicated `/health` endpoint. Use any of these to verify the server is running:

- `GET /api/recording/status`
- `GET /api/files`
- `GET /api/settings`
