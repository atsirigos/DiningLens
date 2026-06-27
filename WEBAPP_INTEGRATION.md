# Snap an Android photo over WiFi — Web App Integration Guide

This guide explains how to let your web app trigger a photo on an Android phone
over the local WiFi network, then display/download the resulting image.

It is written to be dropped into another Cursor workspace. Hand it to your
agent and say *"implement this in my app"*. Integration points you must adapt
to your codebase are marked with **[ADAPT]**.

---

## 1. How it works (important — read first)

A web **browser cannot talk to a phone's ADB directly**. The flow must be:

```
Browser (your web UI)
   │  HTTP request: "take a photo"
   ▼
Your backend server (Node/Python/etc., running on a machine on the LAN)
   │  shells out to the `adb` binary
   ▼
adb  ──(WiFi, ADB wireless debugging)──►  Android phone
   │  photo saved on phone, then pulled back to the server
   ▼
Server returns the image (or a URL) to the browser
```

Key consequences:

- The **server must run on a machine on the same WiFi** as the phone (e.g. your
  dev machine, a home server, or a Raspberry Pi). It will **not** work from a
  cloud host that can't reach the phone's LAN IP.
- The server needs the `adb` binary available.
- This is great for **local / self-hosted / kiosk / lab** setups. It is **not**
  a public-internet feature.

---

## 2. Prerequisites (one-time)

### 2.1 Install ADB on the server machine

Download Google's platform-tools (no admin needed) and note the path to `adb`:

- Windows: https://dl.google.com/android/repository/platform-tools-latest-windows.zip
- macOS:   https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
- Linux:   https://dl.google.com/android/repository/platform-tools-latest-linux.zip

Unzip it; you'll get a `platform-tools/adb` (or `adb.exe`) binary. Either add it
to `PATH` or store the absolute path in an env var (we use `ADB_PATH` below).

### 2.2 Pair the phone with ADB wireless debugging (one-time per phone)

On the phone (Android 11+):

1. **Settings → About phone →** tap **Build number** 7× to unlock Developer options.
   (Samsung: *About phone → Software information → Build number*.)
2. **Settings → Developer options → Wireless debugging →** turn it on.
3. Tap **Pair device with pairing code**. Note the `IP:PORT` and 6-digit code.
4. On the server, pair once:

```bash
adb pair 192.168.1.50:37000     # then type the 6-digit code when prompted
```

5. Back on the **Wireless debugging** main screen there is an **IP address & Port**
   (a *different* port than the pairing one). Connect with that:

```bash
adb connect 192.168.1.50:41413
adb devices        # should list your phone as "device"
```

> Note: the connect port can change when Wireless debugging is toggled. You can
> auto-discover it with `adb mdns services` (see the code below).

### 2.3 Find the right "shutter" for your phone

Camera apps vary. The reference code tries, in order:

1. `KEYCODE_CAMERA` (27) — stock Android.
2. `KEYCODE_VOLUME_UP` (24) — **Samsung** and many others (volume key = shutter).

If neither works on your device, open the camera and find a working key/tap
(see §7 Troubleshooting).

---

## 3. Configuration

Use environment variables so nothing is hard-coded:

```bash
# .env  [ADAPT to your config system]
ADB_PATH=/absolute/path/to/platform-tools/adb     # or just "adb" if on PATH
PHONE_ADDR=192.168.1.50:41413                      # optional; auto-detected if omitted
PHONE_DCIM=/sdcard/DCIM/Camera                     # camera folder on the phone
CAPTURE_DIR=./captures                              # where server saves pulled photos
```

---

## 4. Backend — Node.js (Express) reference implementation

### 4.1 The camera service

Create `server/androidCamera.js`:

```js
// server/androidCamera.js
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs/promises");

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB_PATH || "adb";
const DCIM = process.env.PHONE_DCIM || "/sdcard/DCIM/Camera";
const CAPTURE_DIR = process.env.CAPTURE_DIR || path.join(process.cwd(), "captures");

// Low-level adb call. Returns stdout (trimmed).
async function adb(args, { timeout = 20000 } = {}) {
  const { stdout } = await execFileAsync(ADB, args, { timeout });
  return stdout.toString().trim();
}

// Run a shell command on a specific device.
function adbShell(serial, cmd) {
  return adb(["-s", serial, "shell", cmd]);
}

// Discover a paired wireless device via mDNS if PHONE_ADDR isn't set.
async function discoverDevice() {
  if (process.env.PHONE_ADDR) return process.env.PHONE_ADDR;
  try {
    const out = await adb(["mdns", "services"]);
    const m = out.match(/_adb-tls-connect\._tcp\s+(\S+:\d+)/);
    if (m) return m[1];
  } catch (_) {
    /* mdns may be unsupported; fall through */
  }
  throw new Error("No PHONE_ADDR set and no wireless device found via mDNS.");
}

// Ensure we're connected; returns the device serial (the ip:port).
async function ensureConnected() {
  const addr = await discoverDevice();
  const out = await adb(["connect", addr]);
  if (!/connected/i.test(out)) {
    throw new Error(`Could not connect to ${addr}: ${out}`);
  }
  return addr;
}

// Name of the newest file in the camera folder (or null).
async function latestPhotoName(serial) {
  const out = await adbShell(serial, `ls -t ${DCIM} 2>/dev/null | head -n 1`);
  return out || null;
}

async function waitForNewPhoto(serial, before, { tries = 8, delayMs = 600 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const latest = await latestPhotoName(serial);
    if (latest && latest !== before) return latest;
  }
  return null;
}

/**
 * Takes a photo and pulls it back to the server.
 * @returns {Promise<{file: string, localPath: string}>}
 */
async function takePhoto({ warmupMs = 2500 } = {}) {
  const serial = await ensureConnected();

  const before = await latestPhotoName(serial);

  // Open the stock camera in still-image mode.
  await adbShell(serial, "am start -a android.media.action.STILL_IMAGE_CAMERA");
  await new Promise((r) => setTimeout(r, warmupMs));

  // Attempt 1: hardware camera key (stock Android).
  await adbShell(serial, "input keyevent 27");
  let file = await waitForNewPhoto(serial, before);

  // Attempt 2: volume-up = shutter (Samsung and many others).
  if (!file) {
    await adbShell(serial, "input keyevent 24");
    file = await waitForNewPhoto(serial, before);
  }

  if (!file) {
    throw new Error(
      "Shutter not triggered. This camera app may need a custom key/tap; see Troubleshooting."
    );
  }

  await fs.mkdir(CAPTURE_DIR, { recursive: true });
  const localPath = path.join(CAPTURE_DIR, file);
  await adb(["-s", serial, "pull", `${DCIM}/${file}`, localPath], { timeout: 60000 });

  return { file, localPath };
}

module.exports = { takePhoto, ensureConnected };
```

### 4.2 The HTTP route

```js
// server/routes/camera.js   [ADAPT to your router/framework]
const express = require("express");
const path = require("node:path");
const { takePhoto } = require("../androidCamera");

const router = express.Router();

// POST /api/camera/snap  ->  { file, url }
router.post("/snap", async (req, res) => {
  try {
    const { file, localPath } = await takePhoto();
    // Serve the captures folder statically (see below) so the browser can load it.
    res.json({ file, url: `/captures/${encodeURIComponent(file)}` });
  } catch (err) {
    console.error("snap failed:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

Wire it up in your app entry (**[ADAPT]**):

```js
// server/index.js  (excerpt)
const express = require("express");
const path = require("node:path");
const cameraRouter = require("./routes/camera");

const app = express();
app.use(express.json());

// Make pulled photos loadable by the browser.
app.use(
  "/captures",
  express.static(process.env.CAPTURE_DIR || path.join(process.cwd(), "captures"))
);

app.use("/api/camera", cameraRouter);

app.listen(3000, () => console.log("listening on http://localhost:3000"));
```

---

## 5. Frontend — minimal button + preview

Framework-agnostic vanilla version (**[ADAPT]** to React/Vue/etc.):

```html
<button id="snap">📸 Snap photo</button>
<p id="status"></p>
<img id="preview" alt="" style="max-width: 100%; display: none;" />

<script>
  const btn = document.getElementById("snap");
  const status = document.getElementById("status");
  const preview = document.getElementById("preview");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "Taking photo…";
    try {
      const res = await fetch("/api/camera/snap", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      preview.src = data.url + "?t=" + Date.now(); // cache-bust
      preview.style.display = "block";
      status.textContent = "Saved: " + data.file;
    } catch (e) {
      status.textContent = "Error: " + e.message;
    } finally {
      btn.disabled = false;
    }
  });
</script>
```

React version of the handler (**[ADAPT]**):

```jsx
async function snap() {
  const res = await fetch("/api/camera/snap", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.url; // set into <img src=...>
}
```

---

## 6. Backend — Python (FastAPI) variant

If your app is Python instead of Node, use this in place of §4:

```python
# android_camera.py
import asyncio, os, re
from pathlib import Path

ADB = os.environ.get("ADB_PATH", "adb")
DCIM = os.environ.get("PHONE_DCIM", "/sdcard/DCIM/Camera")
CAPTURE_DIR = Path(os.environ.get("CAPTURE_DIR", "./captures"))


async def _adb(*args, timeout=20):
    proc = await asyncio.create_subprocess_exec(
        ADB, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    return out.decode().strip()


async def _shell(serial, cmd):
    return await _adb("-s", serial, "shell", cmd)


async def _discover():
    if os.environ.get("PHONE_ADDR"):
        return os.environ["PHONE_ADDR"]
    out = await _adb("mdns", "services")
    m = re.search(r"_adb-tls-connect\._tcp\s+(\S+:\d+)", out)
    if not m:
        raise RuntimeError("No PHONE_ADDR set and no wireless device via mDNS.")
    return m.group(1)


async def _ensure_connected():
    addr = await _discover()
    out = await _adb("connect", addr)
    if "connected" not in out.lower():
        raise RuntimeError(f"Could not connect to {addr}: {out}")
    return addr


async def _latest(serial):
    return (await _shell(serial, f"ls -t {DCIM} 2>/dev/null | head -n 1")) or None


async def _wait_new(serial, before, tries=8, delay=0.6):
    for _ in range(tries):
        await asyncio.sleep(delay)
        latest = await _latest(serial)
        if latest and latest != before:
            return latest
    return None


async def take_photo(warmup=2.5):
    serial = await _ensure_connected()
    before = await _latest(serial)

    await _shell(serial, "am start -a android.media.action.STILL_IMAGE_CAMERA")
    await asyncio.sleep(warmup)

    await _shell(serial, "input keyevent 27")          # stock Android shutter
    file = await _wait_new(serial, before)
    if not file:
        await _shell(serial, "input keyevent 24")      # Samsung: volume-up = shutter
        file = await _wait_new(serial, before)
    if not file:
        raise RuntimeError("Shutter not triggered; see Troubleshooting.")

    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    local = CAPTURE_DIR / file
    await _adb("-s", serial, "pull", f"{DCIM}/{file}", str(local), timeout=60)
    return {"file": file, "local_path": str(local)}
```

```python
# main.py (FastAPI)
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from android_camera import take_photo, CAPTURE_DIR

app = FastAPI()
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/captures", StaticFiles(directory=str(CAPTURE_DIR)), name="captures")

@app.post("/api/camera/snap")
async def snap():
    try:
        result = await take_photo()
        return {"file": result["file"], "url": f"/captures/{result['file']}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

---

## 7. Troubleshooting

**Connects but no photo is taken.** Your camera app ignores both shutter keys.
Find a working trigger manually:

```bash
adb -s <ip:port> shell am start -a android.media.action.STILL_IMAGE_CAMERA
# try keys:
adb -s <ip:port> shell input keyevent 27   # CAMERA
adb -s <ip:port> shell input keyevent 24   # VOLUME_UP
# or tap the on-screen shutter by coordinate (find it via screen size):
adb -s <ip:port> shell wm size
adb -s <ip:port> shell input tap <x> <y>   # e.g. center-bottom of the screen
```

Then set whichever works as the trigger in `takePhoto`.

**`adb devices` shows nothing / "offline".** Re-run `adb connect <ip:port>`.
The phone must have **Wireless debugging ON** and be on the same WiFi. The
connect port changes when you toggle it; use `adb mdns services` to find it.

**`unauthorized`.** Accept the "Allow debugging?" prompt on the phone (check
"always allow").

**Photo taken but image is black.** Increase `warmupMs` (camera needs time to
focus/expose before the shutter fires).

**Multiple devices connected.** Always pass `-s <ip:port>` (the code does this).

---

## 8. Security & operational notes

- **LAN only.** Don't expose the `/api/camera/snap` endpoint to the public
  internet. Put it behind your app's auth and/or bind the server to the LAN.
- **ADB = full device control.** Anyone who can hit this endpoint can make the
  phone take photos. Gate it behind authentication.
- **Don't commit secrets/binaries.** Add to `.gitignore`:

```gitignore
captures/
platform-tools/
.env
```

- **Keep Wireless debugging on** on the phone for unattended use; otherwise you
  must re-enable + reconnect each session.
- **Reliability:** for a kiosk-style always-on setup, run `adb connect` on a
  timer/health-check so it reconnects if the phone drops off WiFi.

---

## 9. Quick checklist

- [ ] `adb` installed on the server machine; `ADB_PATH` set (or on PATH).
- [ ] Phone paired once (`adb pair`) and connects (`adb connect`).
- [ ] `adb devices` shows the phone as `device`.
- [ ] Backend route `/api/camera/snap` added and `captures/` served statically.
- [ ] Frontend button calls the route and shows the returned image URL.
- [ ] Correct shutter key confirmed for your phone model.
- [ ] Endpoint protected by auth; `captures/`, `platform-tools/`, `.env` gitignored.
