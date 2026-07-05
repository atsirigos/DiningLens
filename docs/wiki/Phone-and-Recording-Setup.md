# Phone & Recording Setup

## Important: browser cannot talk to ADB directly

```
Browser  →  HTTP  →  DiningLens server  →  adb  →  Android phone
```

The server must run on a machine on the **same LAN** as the phone. This will not work from a cloud host that cannot reach the phone's IP.

See also: [`WEBAPP_INTEGRATION.md`](../../WEBAPP_INTEGRATION.md) for detailed ADB integration notes.

## One-time phone setup

1. Enable **Developer options** (tap Build number 7×)
2. Turn on **Wireless debugging**
3. Pair with pairing code:
   ```bash
   adb pair 192.168.x.x:37000
   ```
4. Connect (use the IP & port shown on the Wireless debugging screen):
   ```bash
   adb connect 192.168.x.x:41413
   adb devices
   ```
5. In DiningLens → **Phone Configuration**, add and select the device

The app can also auto-install platform-tools via **Install ADB** in the Phone Configuration tab.

## One-shot capture

- **Phone Configuration** → **Take test picture**
- API: `POST /api/camera/snap`
- Photos land in `captures/` and appear in the Gallery

## Scheduled recording (timelapse)

Recording captures **JPEG frames on an interval**, not a video file. Playback in the Gallery is a frame scrubber.

| Setting | Default | Range |
|---------|---------|-------|
| Interval | 30 sec | 5–600 sec |
| Max duration | 30 min | 1–240 min |

### API

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/recording/start` | `{ intervalSeconds, maxMinutes }` |
| `POST` | `/api/recording/stop` | — |
| `GET` | `/api/recording/status` | Returns session state, frames, errors |

### What happens during a session

1. Server connects ADB and creates `data/recordings/<YYYY-MM-DD-HH-MM-SS>/`
2. `setInterval` triggers `takePhoto()` (opens camera, sends shutter keycodes, pulls JPEG)
3. On stop, max duration, or repeated failures: photos deleted from phone, screen optionally turned off
4. Frames appear in Gallery as a virtual recording card

The capture loop runs **server-side** — it continues even if you close the browser tab.

## Standalone recording page

**URL:** `http://localhost:3000/start-recording.html`

**Launch:** double-click `start-recording.bat` (Windows)

Features:

- Server wait overlay (polls until API is up)
- Live phone health panel (battery, temperature, storage, GPS)
- Start / Stop buttons with live progress
- Post-session summary: frames, times, location snapshots, failures, cleanup info

## Phone health monitoring

`GET /api/phone/health` reads via ADB `dumpsys`:

- Battery level, charging state, temperature
- Storage used / total
- GPS fix (when available)

Samples are stored in SQLite for historical charts on the **Phone Status** tab.

### Charge control

For long deployments, optional battery management:

- Pauses charging at **80%**
- Resumes at **20%**

May require root on some devices. Configured in Phone Configuration.

## Security note

`/api/camera/snap` and recording endpoints grant ADB-level device control. Keep the server on a trusted LAN only.
