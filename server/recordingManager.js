const path = require('node:path');
const fs = require('node:fs/promises');
const {
  ensureConnected,
  takePhoto,
  getActiveDevice,
  ensureConnectedForDevice,
  deletePhonePhotos,
  deletePhoneFilesByPath,
  closePhoneScreen,
  preparePhoneForVideo,
  startScreenRecord,
  stopScreenRecord,
  pullPhoneFile,
  adbShell,
  isPlayableMp4,
  SCREENRECORD_MAX_SECONDS,
  SCREENRECORD_REMOTE_DIR,
} = require('./androidCamera');
const { getSettings } = require('./db/settingsStore');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

const MODE_TIMELAPSE = 'timelapse';
const MODE_VIDEO = 'video';

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_MINUTES = 30;
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 600;
const MIN_MAX_MINUTES = 1;
const MAX_MAX_MINUTES = 240;
const MAX_CONSECUTIVE_FAILURES = 5;
const CAPTURE_IN_FLIGHT_TIMEOUT_MS = 30000;
const VIDEO_PULL_TIMEOUT_MS = 300000;

let session = null;
let intervalTimer = null;
let maxDurationTimer = null;
let captureInFlight = false;
let nextCaptureAt = null;
let finalizePromise = null;
let screenRecordHandle = null;
let videoSegmentChainPromise = null;

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

function parseMode(value) {
  const mode = String(value || MODE_TIMELAPSE).toLowerCase().trim();
  if (mode === MODE_VIDEO || mode === 'full' || mode === 'fullvideo') return MODE_VIDEO;
  return MODE_TIMELAPSE;
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

function buildMediaEntry(sessionId, file) {
  if (!sessionId || !file) return null;
  const relativePath = path.posix.join('recordings', sessionId, file);
  const urlPath = relativePath.split('/').map(encodeURIComponent).join('/');
  return {
    file,
    relativePath,
    url: `/api/file/${urlPath}`,
  };
}

function getPublicSession() {
  if (!session) return null;
  const {
    destDir,
    remoteVideoPaths,
    phoneFiles,
    device,
    ...publicSession
  } = session;
  return {
    ...publicSession,
    frames: session.frames || [],
    videos: session.videos || [],
  };
}

function idleStatus() {
  return {
    status: 'idle',
    mode: MODE_TIMELAPSE,
    sessionId: null,
    startedAt: null,
    stoppedAt: null,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    maxMinutes: DEFAULT_MAX_MINUTES,
    intervalMs: DEFAULT_INTERVAL_SECONDS * 1000,
    maxDurationMs: DEFAULT_MAX_MINUTES * 60 * 1000,
    framesCaptured: 0,
    frames: [],
    videos: [],
    videoSegments: 0,
    lastError: null,
    errors: [],
    consecutiveFailures: 0,
    elapsedMs: 0,
    remainingMs: 0,
    nextCaptureInMs: null,
    phoneCleanup: null,
  };
}

function getBaseStatus() {
  if (!session) return idleStatus();

  const now = Date.now();
  const startedAtMs = session.startedAt ? Date.parse(session.startedAt) : now;
  const elapsedMs = Math.max(0, now - startedAtMs);
  const remainingMs = session.status === 'recording'
    ? Math.max(0, session.maxDurationMs - elapsedMs)
    : 0;
  const nextCaptureInMs = session.status === 'recording'
    && session.mode === MODE_TIMELAPSE
    && nextCaptureAt
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
  if (activeSession.mode === MODE_VIDEO) {
    return [...new Set(activeSession.remoteVideoPaths || [])];
  }
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
    const filesToDelete = getPhoneFilesToDelete(activeSession);

    if (filesToDelete.length) {
      if (activeSession.mode === MODE_VIDEO) {
        const { deleted, failed } = await deletePhoneFilesByPath(serial, filesToDelete);
        phoneCleanup.deletedCount = deleted.length;
        phoneCleanup.failed = failed;
      } else {
        const dcim = getSettings().phone?.dcim;
        const { deleted, failed } = await deletePhonePhotos(
          serial,
          filesToDelete,
          { dcim },
        );
        phoneCleanup.deletedCount = deleted.length;
        phoneCleanup.failed = failed;
      }
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

async function pullVideoSegment(activeSession, remotePath, segmentIndex) {
  if (!activeSession || !remotePath) return null;

  const serial = await ensureConnectedForDevice(activeSession.device);
  const file = `video_${String(segmentIndex).padStart(3, '0')}.mp4`;
  const localPath = path.join(activeSession.destDir, file);

  try {
    const out = await adbShell(
      serial,
      `test -f '${remotePath.replace(/'/g, `'\\''`)}' && echo 1 || echo 0`,
    );
    if (out.trim() !== '1') {
      console.warn(`[recording] video segment missing on phone: ${remotePath}`);
      return null;
    }

    await pullPhoneFile(serial, remotePath, localPath, { timeout: VIDEO_PULL_TIMEOUT_MS });

    const playable = await isPlayableMp4(localPath);
    if (!playable) {
      const message = 'Pulled video is incomplete (missing MP4 metadata). Try recording again and stop with the Stop button — do not kill the server mid-record.';
      try {
        await fs.unlink(localPath);
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }

    const entry = buildMediaEntry(activeSession.sessionId, file);
    if (!activeSession.videos.some((v) => v.file === file)) {
      activeSession.videos.push(entry);
    }
    activeSession.videoSegments = activeSession.videos.length;
    if (!activeSession.remoteVideoPaths.includes(remotePath)) {
      activeSession.remoteVideoPaths.push(remotePath);
    }
    console.log(`[recording] pulled video segment ${segmentIndex}: ${localPath}`);
    return entry;
  } catch (err) {
    activeSession.lastError = err.message;
    activeSession.errors = [...(activeSession.errors || []).slice(-9), {
      at: new Date().toISOString(),
      message: err.message,
    }];
    console.error('[recording] video pull failed:', err.message);
    throw err;
  }
}

async function stopActiveScreenRecord() {
  const handle = screenRecordHandle;
  screenRecordHandle = null;
  if (!handle) return null;
  await stopScreenRecord(handle);
  return handle;
}

function remainingVideoSeconds(activeSession) {
  if (!activeSession?.startedAt || !activeSession.maxDurationMs) return 0;
  const elapsed = Date.now() - Date.parse(activeSession.startedAt);
  return Math.max(0, Math.ceil((activeSession.maxDurationMs - elapsed) / 1000));
}

async function startNextVideoSegment() {
  if (!session || session.status !== 'recording' || session.mode !== MODE_VIDEO) {
    return;
  }

  const remainingSec = remainingVideoSeconds(session);
  if (remainingSec < 1) {
    await finalizeRecording('max_duration');
    return;
  }

  const segmentIndex = (session.videos?.length || 0) + 1;
  const remotePath = `${SCREENRECORD_REMOTE_DIR}/${session.sessionId}_${String(segmentIndex).padStart(3, '0')}.mp4`;
  const timeLimitSec = Math.min(SCREENRECORD_MAX_SECONDS, remainingSec);

  try {
    screenRecordHandle = await startScreenRecord({
      device: session.device,
      remotePath,
      timeLimitSec,
    });
    session.remoteVideoPaths.push(remotePath);
    session.lastError = null;
    session.consecutiveFailures = 0;
    console.log(
      `[recording] video segment ${segmentIndex} started `
      + `(limit ${timeLimitSec}s): ${remotePath}`,
    );

    const handle = screenRecordHandle;
    handle.sessionId = session.sessionId;
    handle.segmentIndex = segmentIndex;

    handle.exitPromise.then(async (result) => {
      if (!session || session.sessionId !== handle.sessionId) return;
      if (session.status !== 'recording') return;
      if (screenRecordHandle !== handle) return;

      screenRecordHandle = null;
      try {
        await pullVideoSegment(session, handle.remotePath, handle.segmentIndex);
      } catch {
        session.consecutiveFailures += 1;
        if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await finalizeRecording('too_many_failures');
          return;
        }
      }

      if (!session || session.status !== 'recording') return;

      const stillRemaining = remainingVideoSeconds(session);
      if (stillRemaining < 1) {
        await finalizeRecording('max_duration');
        return;
      }

      // Natural segment end — chain the next clip
      videoSegmentChainPromise = startNextVideoSegment().catch((err) => {
        console.error('[recording] next video segment failed:', err.message);
        if (session) session.lastError = err.message;
        finalizeRecording('too_many_failures').catch(() => {});
      });
    }).catch((err) => {
      console.error('[recording] screenrecord exit handler failed:', err.message);
    });
  } catch (err) {
    session.consecutiveFailures += 1;
    session.lastError = err.message;
    session.errors = [...session.errors.slice(-9), {
      at: new Date().toISOString(),
      message: err.message,
    }];
    console.error('[recording] video segment start failed:', err.message);
    if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await finalizeRecording('too_many_failures');
    }
    throw err;
  }
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
      `[recording] finalizing (${reason}, mode=${activeSession.mode}, `
      + `${activeSession.framesCaptured} frames, ${activeSession.videos?.length || 0} videos)`,
    );

    if (activeSession.mode === MODE_VIDEO) {
      try {
        const stoppedHandle = await stopActiveScreenRecord();
        if (stoppedHandle?.remotePath) {
          try {
            await pullVideoSegment(
              activeSession,
              stoppedHandle.remotePath,
              stoppedHandle.segmentIndex || (activeSession.videos.length + 1),
            );
          } catch (err) {
            console.error('[recording] final in-progress video pull failed:', err.message);
          }
        }

        const pulledFiles = new Set((activeSession.videos || []).map((v) => v.file));
        const remotes = activeSession.remoteVideoPaths || [];
        for (let i = 0; i < remotes.length; i += 1) {
          const expectedFile = `video_${String(i + 1).padStart(3, '0')}.mp4`;
          if (pulledFiles.has(expectedFile)) continue;
          try {
            await pullVideoSegment(activeSession, remotes[i], i + 1);
          } catch (err) {
            console.error('[recording] final video pull failed:', err.message);
            activeSession.lastError = activeSession.lastError || err.message;
          }
        }
      } catch (err) {
        console.error('[recording] video finalize failed:', err.message);
        activeSession.lastError = activeSession.lastError || err.message;
      }
    } else {
      await waitForCaptureInFlight();
    }

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
    screenRecordHandle = null;
  }

  return getStatus();
}

async function captureFrame() {
  if (!session || session.status !== 'recording' || captureInFlight) {
    return;
  }
  if (session.mode !== MODE_TIMELAPSE) return;

  captureInFlight = true;
  try {
    const { file, localPath } = await takePhoto({
      device: session.device,
      destDir: session.destDir,
    });
    const frame = buildMediaEntry(session.sessionId, file);
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
    if (session?.status === 'recording' && session.mode === MODE_TIMELAPSE) {
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

async function startRecording({ mode, intervalSeconds, maxMinutes } = {}) {
  if (session?.status === 'recording') {
    throw new Error('A recording session is already in progress.');
  }

  const recordingMode = parseMode(mode);
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
  screenRecordHandle = null;
  videoSegmentChainPromise = null;

  session = {
    status: 'recording',
    mode: recordingMode,
    sessionId,
    destDir,
    device: activeDevice,
    deviceId: activeDevice.id,
    deviceName: activeDevice.name,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stopReason: null,
    intervalSeconds: recordingMode === MODE_TIMELAPSE ? interval : null,
    maxMinutes: maxMins,
    intervalMs: recordingMode === MODE_TIMELAPSE ? intervalMs : null,
    maxDurationMs,
    framesCaptured: 0,
    frames: [],
    videos: [],
    videoSegments: 0,
    phoneFiles: [],
    remoteVideoPaths: [],
    lastError: null,
    errors: [],
    consecutiveFailures: 0,
    phoneCleanup: null,
  };

  if (recordingMode === MODE_VIDEO) {
    const serial = await ensureConnectedForDevice(activeDevice);
    await preparePhoneForVideo(serial);
    await startNextVideoSegment();
  } else {
    await captureFrame();
    scheduleCaptureLoop();
  }

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
  MODE_TIMELAPSE,
  MODE_VIDEO,
};
