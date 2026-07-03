const path = require('node:path');
const fs = require('node:fs/promises');
const {
  ensureConnected,
  takePhoto,
  getActiveDevice,
  ensureConnectedForDevice,
  deletePhonePhotos,
  closePhoneScreen,
} = require('./androidCamera');
const { getSettings } = require('./db/settingsStore');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_MINUTES = 30;
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 600;
const MIN_MAX_MINUTES = 1;
const MAX_MAX_MINUTES = 240;
const MAX_CONSECUTIVE_FAILURES = 5;
const CAPTURE_IN_FLIGHT_TIMEOUT_MS = 30000;

let session = null;
let intervalTimer = null;
let maxDurationTimer = null;
let captureInFlight = false;
let nextCaptureAt = null;
let finalizePromise = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseIntervalSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS;
  return clamp(Math.round(parsed), MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
}

function parseMaxMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_MINUTES;
  return clamp(Math.round(parsed), MIN_MAX_MINUTES, MAX_MAX_MINUTES);
}

function makeSessionId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('-');
}

function clearTimers() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  }
  nextCaptureAt = null;
}

function buildFrame(sessionId, file) {
  if (!sessionId || !file) return null;
  const relativePath = path.posix.join('recordings', sessionId, file);
  return {
    file,
    relativePath,
    url: `/api/file/${encodeURIComponent(relativePath)}`,
  };
}

function getPublicSession() {
  if (!session) return null;
  const { destDir, ...publicSession } = session;
  return {
    ...publicSession,
    frames: session.frames || [],
  };
}

function getBaseStatus() {
  if (!session) {
    return {
      status: 'idle',
      sessionId: null,
      startedAt: null,
      stoppedAt: null,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      maxMinutes: DEFAULT_MAX_MINUTES,
      intervalMs: DEFAULT_INTERVAL_SECONDS * 1000,
      maxDurationMs: DEFAULT_MAX_MINUTES * 60 * 1000,
      framesCaptured: 0,
      frames: [],
      lastError: null,
      errors: [],
      consecutiveFailures: 0,
      elapsedMs: 0,
      remainingMs: 0,
      nextCaptureInMs: null,
      phoneCleanup: null,
    };
  }

  const now = Date.now();
  const startedAtMs = session.startedAt ? Date.parse(session.startedAt) : now;
  const elapsedMs = Math.max(0, now - startedAtMs);
  const remainingMs = session.status === 'recording'
    ? Math.max(0, session.maxDurationMs - elapsedMs)
    : 0;
  const nextCaptureInMs = session.status === 'recording' && nextCaptureAt
    ? Math.max(0, nextCaptureAt - now)
    : null;

  return {
    ...getPublicSession(),
    elapsedMs,
    remainingMs,
    nextCaptureInMs,
  };
}

async function waitForCaptureInFlight() {
  const deadline = Date.now() + CAPTURE_IN_FLIGHT_TIMEOUT_MS;
  while (captureInFlight && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

function getPhoneFilesToDelete(activeSession) {
  const tracked = activeSession.phoneFiles || [];
  const fromFrames = (activeSession.frames || []).map((frame) => frame.file).filter(Boolean);
  return [...new Set([...tracked, ...fromFrames])];
}

async function runPhoneCleanup(activeSession) {
  const phoneCleanup = {
    deletedCount: 0,
    failed: [],
    screenClosed: false,
  };

  if (!activeSession?.device) {
    return phoneCleanup;
  }

  try {
    const serial = await ensureConnectedForDevice(activeSession.device);
    const dcim = getSettings().phone?.dcim;
    const filesToDelete = getPhoneFilesToDelete(activeSession);

    if (filesToDelete.length) {
      const { deleted, failed } = await deletePhonePhotos(
        serial,
        filesToDelete,
        { dcim },
      );
      phoneCleanup.deletedCount = deleted.length;
      phoneCleanup.failed = failed;
    }

    phoneCleanup.screenClosed = await closePhoneScreen(serial);
  } catch (err) {
    console.error('[recording] phone cleanup failed:', err.message);
    phoneCleanup.error = err.message;
    try {
      const serial = await ensureConnectedForDevice(activeSession.device);
      phoneCleanup.screenClosed = await closePhoneScreen(serial);
    } catch {
      phoneCleanup.screenClosed = false;
    }
  }

  return phoneCleanup;
}

async function finalizeRecording(reason) {
  if (finalizePromise) {
    await finalizePromise;
    return getStatus();
  }

  if (!session || (session.status !== 'recording' && session.status !== 'error')) {
    return getStatus();
  }

  finalizePromise = (async () => {
    const activeSession = session;
    const terminalStatus = reason === 'too_many_failures' ? 'error' : 'stopped';

    activeSession.status = terminalStatus;
    activeSession.stoppedAt = activeSession.stoppedAt || new Date().toISOString();
    activeSession.stopReason = reason;
    clearTimers();

    console.log(
      `[recording] finalizing (${reason}, ${activeSession.framesCaptured} frames)`,
    );

    await waitForCaptureInFlight();
    activeSession.phoneCleanup = await runPhoneCleanup(activeSession);

    console.log(
      `[recording] phone cleanup: deleted ${activeSession.phoneCleanup.deletedCount}, `
      + `screen closed: ${activeSession.phoneCleanup.screenClosed}`,
    );
  })();

  try {
    await finalizePromise;
  } finally {
    finalizePromise = null;
  }

  return getStatus();
}

async function captureFrame() {
  if (!session || session.status !== 'recording' || captureInFlight) {
    return;
  }

  captureInFlight = true;
  try {
    const { file, localPath } = await takePhoto({
      device: session.device,
      destDir: session.destDir,
    });
    const frame = buildFrame(session.sessionId, file);
    session.frames.push(frame);
    session.framesCaptured += 1;
    session.phoneFiles.push(file);
    session.lastError = null;
    session.consecutiveFailures = 0;
    session.errors = session.errors.slice(-9);
    console.log(`[recording] captured frame ${session.framesCaptured}: ${localPath}`);
  } catch (err) {
    session.consecutiveFailures += 1;
    session.lastError = err.message;
    session.errors = [...session.errors.slice(-9), {
      at: new Date().toISOString(),
      message: err.message,
    }];
    console.error('[recording] capture failed:', err.message);

    if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      Promise.resolve().then(() => {
        finalizeRecording('too_many_failures').catch((err) => {
          console.error('[recording] failure finalize failed:', err.message);
        });
      });
    }
  } finally {
    captureInFlight = false;
    if (session?.status === 'recording') {
      nextCaptureAt = Date.now() + session.intervalMs;
    }
  }
}

function scheduleCaptureLoop() {
  nextCaptureAt = Date.now() + session.intervalMs;
  intervalTimer = setInterval(() => {
    captureFrame();
  }, session.intervalMs);
}

async function startRecording({ intervalSeconds, maxMinutes } = {}) {
  if (session?.status === 'recording') {
    throw new Error('A recording session is already in progress.');
  }

  const interval = parseIntervalSeconds(intervalSeconds);
  const maxMins = parseMaxMinutes(maxMinutes);
  const intervalMs = interval * 1000;
  const maxDurationMs = maxMins * 60 * 1000;

  await ensureConnected();

  const activeDevice = getActiveDevice();
  if (!activeDevice) {
    throw new Error('No active device configured. Add and select a device in Phone Configuration.');
  }

  const sessionId = makeSessionId();
  const destDir = path.join(RECORDINGS_DIR, sessionId);
  await fs.mkdir(destDir, { recursive: true });

  clearTimers();
  captureInFlight = false;
  finalizePromise = null;

  session = {
    status: 'recording',
    sessionId,
    destDir,
    device: activeDevice,
    deviceId: activeDevice.id,
    deviceName: activeDevice.name,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stopReason: null,
    intervalSeconds: interval,
    maxMinutes: maxMins,
    intervalMs,
    maxDurationMs,
    framesCaptured: 0,
    frames: [],
    phoneFiles: [],
    lastError: null,
    errors: [],
    consecutiveFailures: 0,
    phoneCleanup: null,
  };

  await captureFrame();
  scheduleCaptureLoop();

  maxDurationTimer = setTimeout(() => {
    if (session?.status === 'recording') {
      finalizeRecording('max_duration').catch((err) => {
        console.error('[recording] max duration finalize failed:', err.message);
      });
    }
  }, maxDurationMs);

  return getStatus();
}

async function stopRecording() {
  if (!session || session.status !== 'recording') {
    return getStatus();
  }

  return finalizeRecording('manual');
}

function getStatus() {
  return getBaseStatus();
}

module.exports = {
  startRecording,
  stopRecording,
  getStatus,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_MINUTES,
};
