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
  waitForScreenRecordIdle,
  startScreenRecord,
  stopScreenRecord,
  pullPhoneFile,
  adbShell,
  isPlayableMp4,
  SCREENRECORD_MAX_SECONDS,
  SCREENRECORD_REMOTE_DIR,
} = require('./androidCamera');
const { getSettings } = require('./db/settingsStore');
const { generateVideoThumbnail } = require('./utils/videoThumb');

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
/** remotePath -> in-flight pull promise (dedupes natural-end vs finalize). */
const videoPullPromises = new Map();
/** Pre-session / in-flight lifecycle progress (also mirrored onto session when present). */
let pendingPhase = null;
let pendingPhaseMessage = null;

function setPhase(phase, message) {
  pendingPhase = phase || null;
  pendingPhaseMessage = message || null;
  if (session) {
    session.phase = pendingPhase;
    session.phaseMessage = pendingPhaseMessage;
  }
}

function clearPhase() {
  setPhase(null, null);
}

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
    deviceSerial,
    nextSegmentIndex,
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
    phase: null,
    phaseMessage: null,
  };
}

function getBaseStatus() {
  if (!session) {
    const idle = idleStatus();
    if (pendingPhase) {
      return {
        ...idle,
        status: 'starting',
        phase: pendingPhase,
        phaseMessage: pendingPhaseMessage,
      };
    }
    return idle;
  }

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
    phase: session.phase ?? pendingPhase,
    phaseMessage: session.phaseMessage ?? pendingPhaseMessage,
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

  const file = `video_${String(segmentIndex).padStart(3, '0')}.mp4`;
  if ((activeSession.videos || []).some((video) => video.file === file)) {
    return activeSession.videos.find((video) => video.file === file) || null;
  }

  const serial = await ensureConnectedForDevice(activeSession.device);
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

    const stat = await fs.stat(localPath);
    // Near-empty screenrecord outputs are usually failed/interrupted starts (often 0:00 in players).
    if (stat.size < 64 * 1024) {
      try {
        await fs.unlink(localPath);
      } catch {
        /* ignore */
      }
      throw new Error(
        `Pulled video is too small (${stat.size} bytes) — the clip likely failed to start or ended immediately.`,
      );
    }

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

    try {
      await generateVideoThumbnail(localPath, { force: true });
    } catch (err) {
      console.warn(`[recording] video thumbnail failed for ${file}:`, err.message);
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

function segmentIndexFromRemotePath(remotePath, fallbackIndex) {
  const match = String(remotePath || '').match(/_(\d+)\.mp4$/i);
  if (!match) return fallbackIndex;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackIndex;
}

function enqueueVideoPull(activeSession, remotePath, segmentIndex) {
  if (!activeSession || !remotePath) return Promise.resolve(null);

  const existing = videoPullPromises.get(remotePath);
  if (existing) return existing;

  const index = segmentIndex || segmentIndexFromRemotePath(remotePath, 1);
  const promise = pullVideoSegment(activeSession, remotePath, index)
    .then((entry) => {
      if (session === activeSession && entry) {
        activeSession.consecutiveFailures = 0;
      }
      return entry;
    })
    .catch((err) => {
      if (session === activeSession) {
        activeSession.consecutiveFailures += 1;
      }
      throw err;
    })
    .finally(() => {
      videoPullPromises.delete(remotePath);
    });

  videoPullPromises.set(remotePath, promise);
  return promise;
}

async function waitForVideoPulls() {
  const pending = [...videoPullPromises.values()];
  if (!pending.length) return;
  await Promise.allSettled(pending);
}

function remainingVideoSeconds(activeSession) {
  if (!activeSession?.startedAt || !activeSession.maxDurationMs) return 0;
  const elapsed = Date.now() - Date.parse(activeSession.startedAt);
  return Math.max(0, Math.ceil((activeSession.maxDurationMs - elapsed) / 1000));
}

function allocateVideoSegment(activeSession) {
  const segmentIndex = activeSession.nextSegmentIndex || 1;
  activeSession.nextSegmentIndex = segmentIndex + 1;
  const remotePath = `${SCREENRECORD_REMOTE_DIR}/${activeSession.sessionId}_${String(segmentIndex).padStart(3, '0')}.mp4`;
  return { segmentIndex, remotePath };
}

async function startNextVideoSegment() {
  if (!session || (session.status !== 'recording' && session.status !== 'starting') || session.mode !== MODE_VIDEO) {
    return;
  }

  const remainingSec = remainingVideoSeconds(session);
  if (remainingSec < 1) {
    await finalizeRecording('max_duration');
    return;
  }

  const serial = session.deviceSerial
    || await ensureConnectedForDevice(session.device);
  session.deviceSerial = serial;

  // Previous screenrecord must fully exit; then reopen camera so we don't record the launcher.
  setPhase(
    session.status === 'starting' ? 'preparing_camera' : 'starting_recorder',
    session.status === 'starting'
      ? 'Waking phone and opening camera…'
      : 'Reopening camera for next clip…',
  );
  await waitForScreenRecordIdle(serial);
  if (!session || (session.status !== 'recording' && session.status !== 'starting')) {
    return;
  }
  await preparePhoneForVideo(serial, {
    warmupMs: session.status === 'starting' ? 1200 : 900,
  });
  if (!session || (session.status !== 'recording' && session.status !== 'starting')) {
    return;
  }

  const { segmentIndex, remotePath } = allocateVideoSegment(session);
  const timeLimitSec = Math.min(SCREENRECORD_MAX_SECONDS, remainingSec);

  try {
    setPhase('starting_recorder', `Starting screen recorder (clip ${segmentIndex})…`);
    const handle = await startScreenRecord({
      device: session.device,
      remotePath,
      timeLimitSec,
    });

    // Stop may have begun while screenrecord was starting.
    if (!session || (session.status !== 'recording' && session.status !== 'starting')) {
      await stopScreenRecord(handle);
      if (session && !session.remoteVideoPaths.includes(remotePath)) {
        session.remoteVideoPaths.push(remotePath);
      }
      return;
    }

    screenRecordHandle = handle;
    if (!session.remoteVideoPaths.includes(remotePath)) {
      session.remoteVideoPaths.push(remotePath);
    }
    console.log(
      `[recording] video segment ${segmentIndex} started `
      + `(limit ${timeLimitSec}s): ${remotePath}`,
    );

    handle.sessionId = session.sessionId;
    handle.segmentIndex = segmentIndex;
    if (session.status === 'recording') {
      clearPhase();
    }

    handle.exitPromise.then(async () => {
      if (!session || session.sessionId !== handle.sessionId) return;
      if (session.status !== 'recording') return;
      if (screenRecordHandle !== handle) return;

      // Detach before chaining so finalize cannot stop the wrong process.
      screenRecordHandle = null;

      const stillRemaining = remainingVideoSeconds(session);
      let chainFailed = false;

      // Start the next clip first to minimize dead air, then pull in the background.
      if (stillRemaining >= 1) {
        try {
          videoSegmentChainPromise = startNextVideoSegment();
          await videoSegmentChainPromise;
        } catch (err) {
          chainFailed = true;
          console.error('[recording] next video segment failed:', err.message);
          if (session) {
            session.lastError = err.message;
            session.consecutiveFailures += 1;
          }
        } finally {
          videoSegmentChainPromise = null;
        }
      }

      if (!session || session.sessionId !== handle.sessionId) return;
      if (session.status !== 'recording') return;

      enqueueVideoPull(session, handle.remotePath, handle.segmentIndex).catch(async () => {
        if (session?.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await finalizeRecording('too_many_failures').catch(() => {});
        }
      });

      if (stillRemaining < 1) {
        await finalizeRecording('max_duration');
        return;
      }

      if (chainFailed && session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await finalizeRecording('too_many_failures').catch(() => {});
      }
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

  const activeSession = session;
  const terminalStatus = reason === 'too_many_failures' ? 'error' : 'stopped';

  // Claim stop synchronously so exit handlers do not chain another segment.
  activeSession.status = 'stopping';
  activeSession.stoppedAt = activeSession.stoppedAt || new Date().toISOString();
  activeSession.stopReason = reason;
  clearTimers();

  const handleToStop = screenRecordHandle;
  screenRecordHandle = null;

  finalizePromise = (async () => {
    setPhase('stopping', 'Stopping recording…');

    console.log(
      `[recording] finalizing (${reason}, mode=${activeSession.mode}, `
      + `${activeSession.framesCaptured} frames, ${activeSession.videos?.length || 0} videos)`,
    );

    if (activeSession.mode === MODE_VIDEO) {
      try {
        if (videoSegmentChainPromise) {
          await videoSegmentChainPromise.catch(() => {});
          videoSegmentChainPromise = null;
        }

        setPhase('stopping_recorder', 'Stopping phone screen recorder…');
        if (handleToStop) {
          await stopScreenRecord(handleToStop);
          try {
            setPhase('pulling_video', 'Downloading video from phone…');
            await enqueueVideoPull(
              activeSession,
              handleToStop.remotePath,
              handleToStop.segmentIndex
                || segmentIndexFromRemotePath(handleToStop.remotePath, activeSession.videos.length + 1),
            );
          } catch (err) {
            console.error('[recording] final in-progress video pull failed:', err.message);
          }
        }

        setPhase('pulling_video', 'Downloading remaining video clips…');
        await waitForVideoPulls();

        const pulledFiles = new Set((activeSession.videos || []).map((v) => v.file));
        const remotes = activeSession.remoteVideoPaths || [];
        for (let i = 0; i < remotes.length; i += 1) {
          const segmentIndex = segmentIndexFromRemotePath(remotes[i], i + 1);
          const expectedFile = `video_${String(segmentIndex).padStart(3, '0')}.mp4`;
          if (pulledFiles.has(expectedFile)) continue;
          try {
            setPhase('pulling_video', `Downloading video clip ${segmentIndex} from phone…`);
            await enqueueVideoPull(activeSession, remotes[i], segmentIndex);
            pulledFiles.add(expectedFile);
          } catch (err) {
            console.error('[recording] final video pull failed:', err.message);
            activeSession.lastError = activeSession.lastError || err.message;
          }
        }

        await waitForVideoPulls();
      } catch (err) {
        console.error('[recording] video finalize failed:', err.message);
        activeSession.lastError = activeSession.lastError || err.message;
      }
    } else {
      setPhase('waiting_capture', 'Waiting for in-progress photo to finish…');
      await waitForCaptureInFlight();
    }

    setPhase('cleaning_phone', 'Cleaning up phone files and turning screen off…');
    activeSession.phoneCleanup = await runPhoneCleanup(activeSession);

    console.log(
      `[recording] phone cleanup: deleted ${activeSession.phoneCleanup.deletedCount}, `
      + `screen closed: ${activeSession.phoneCleanup.screenClosed}`,
    );

    activeSession.status = terminalStatus;
    clearPhase();
  })();

  try {
    await finalizePromise;
  } finally {
    finalizePromise = null;
    screenRecordHandle = null;
    videoPullPromises.clear();
    if (session?.status === 'stopping') {
      session.status = reason === 'too_many_failures' ? 'error' : 'stopped';
      clearPhase();
    }
  }

  return getStatus();
}

async function captureFrame() {
  if (!session || (session.status !== 'recording' && session.status !== 'starting') || captureInFlight) {
    return;
  }
  if (session.mode !== MODE_TIMELAPSE) return;

  captureInFlight = true;
  try {
    const { file, localPath, serial } = await takePhoto({
      device: session.device,
      serial: session.deviceSerial || null,
      destDir: session.destDir,
    });
    if (serial) session.deviceSerial = serial;
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
  if (session?.status === 'recording' || session?.status === 'starting') {
    throw new Error('A recording session is already in progress.');
  }
  if (session?.status === 'stopping') {
    throw new Error('A recording is still stopping. Please wait.');
  }

  const recordingMode = parseMode(mode);
  const interval = parseIntervalSeconds(intervalSeconds);
  const maxMins = parseMaxMinutes(maxMinutes);
  const intervalMs = interval * 1000;
  const maxDurationMs = maxMins * 60 * 1000;
  const startedMs = Date.now();
  const mark = (label) => {
    console.log(`[recording] start +${Date.now() - startedMs}ms: ${label}`);
  };

  setPhase('connecting', 'Connecting to phone…');

  try {
    const serial = await ensureConnected();
    mark('connected');

    const activeDevice = getActiveDevice();
    if (!activeDevice) {
      throw new Error('No active device configured. Add and select a device in Phone Configuration.');
    }

    setPhase('preparing', 'Preparing recording session…');
    const sessionId = makeSessionId();
    const destDir = path.join(RECORDINGS_DIR, sessionId);
    await fs.mkdir(destDir, { recursive: true });

    clearTimers();
    captureInFlight = false;
    finalizePromise = null;
    screenRecordHandle = null;
    videoSegmentChainPromise = null;
    videoPullPromises.clear();

    session = {
      status: 'starting',
      mode: recordingMode,
      sessionId,
      destDir,
      device: activeDevice,
      deviceSerial: serial,
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
      nextSegmentIndex: 1,
      phoneFiles: [],
      remoteVideoPaths: [],
      lastError: null,
      errors: [],
      consecutiveFailures: 0,
      phoneCleanup: null,
      phase: pendingPhase,
      phaseMessage: pendingPhaseMessage,
    };

    if (recordingMode === MODE_VIDEO) {
      setPhase('starting_recorder', 'Starting screen recorder…');
      await startNextVideoSegment();
      mark('screenrecord started');
    } else {
      setPhase('first_capture', 'Taking first photo (camera warmup)…');
      await captureFrame();
      mark('first frame captured');
      scheduleCaptureLoop();
    }

    session.status = 'recording';
    clearPhase();
    mark('ready');

    maxDurationTimer = setTimeout(() => {
      if (session?.status === 'recording') {
        finalizeRecording('max_duration').catch((err) => {
          console.error('[recording] max duration finalize failed:', err.message);
        });
      }
    }, maxDurationMs);

    return getStatus();
  } catch (err) {
    clearTimers();
    if (session && (session.status === 'starting' || session.status === 'recording')) {
      session.status = 'error';
      session.lastError = err.message;
      session.stoppedAt = new Date().toISOString();
      session.stopReason = 'start_failed';
    }
    clearPhase();
    throw err;
  }
}

async function stopRecording() {
  if (!session || session.status !== 'recording') {
    if (session?.status === 'stopping') {
      return finalizeRecording(session.stopReason || 'manual');
    }
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
