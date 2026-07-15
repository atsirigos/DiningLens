const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const {
  preserveCaptureTimestamp,
  readVideoMeta,
  ensureCapturedAt,
  isCaptureTimeLikelyEncodeTime,
} = require('./videoMeta');

const execFileAsync = promisify(execFile);

const ALLOWED_VIDEO_TARGET_FPS = [0, 1, 2, 5, 10, 15, 30];

/** @type {Map<string, object>} */
const fpsJobs = new Map();

/** Match leftover ffmpeg targets like `video_002.mp4.fps5.tmp.mp4`. */
function isVideoEncodeTempName(filename) {
  return /\.fps\d+\.tmp\.(mp4|mov)$/i.test(String(filename || ''));
}

function getFfmpegPath() {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

/**
 * Normalize user FPS setting. 0 / null = keep native screenrecord FPS (no postprocess).
 */
function normalizeVideoTargetFps(value) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return 0;
  if (ALLOWED_VIDEO_TARGET_FPS.includes(parsed)) return parsed;
  if (parsed < 1) return 0;
  const positives = ALLOWED_VIDEO_TARGET_FPS.filter((fps) => fps > 0);
  return positives.reduce((best, fps) => (
    Math.abs(fps - parsed) < Math.abs(best - parsed) ? fps : best
  ), positives[0]);
}

function parseDurationSeconds(stderr) {
  const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function parseFpsFromProbe(stderr) {
  const videoBlock = String(stderr || '').match(
    /Stream #\d+:\d+(?:\([^)]*\))?: Video:[\s\S]*?(?=Stream #|\n\s*$|$)/i,
  );
  const haystack = videoBlock ? videoBlock[0] : String(stderr || '');
  const fpsMatch = haystack.match(/(\d+(?:\.\d+)?)\s*fps/i)
    || haystack.match(/(\d+(?:\.\d+)?)\s*tbr/i);
  if (!fpsMatch) return null;
  const fps = Number(fpsMatch[1]);
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.round(fps * 100) / 100;
}

async function probeVideoMeta(absoluteVideoPath) {
  const videoPath = path.resolve(absoluteVideoPath);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) return { fps: null, durationSec: null };

  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', videoPath], {
      timeout: 30000,
      windowsHide: true,
    });
  } catch (err) {
    stderr = String(err.stderr || err.message || '');
  }

  return {
    fps: parseFpsFromProbe(stderr),
    durationSec: parseDurationSeconds(stderr),
  };
}

/**
 * Probe nominal video FPS from container metadata via ffmpeg (-i exit).
 */
async function probeVideoFps(absoluteVideoPath) {
  const meta = await probeVideoMeta(absoluteVideoPath);
  return meta.fps;
}

function parseProgressTimeSec(chunk) {
  const text = String(chunk || '');
  const msMatch = text.match(/out_time_ms=(\d+)/);
  if (msMatch) {
    return Number(msMatch[1]) / 1e6;
  }
  const timeMatch = text.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (timeMatch) {
    return Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
  }
  return null;
}

function runFfmpegWithProgress(ffmpegPath, args, { durationSec = null, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let lastOutSec = 0;

    const emitProgress = (outSec) => {
      if (typeof onProgress !== 'function') return;
      const currentSec = Math.max(0, outSec);
      lastOutSec = currentSec;
      const duration = Number(durationSec);
      const hasDuration = Number.isFinite(duration) && duration > 0;
      const percent = hasDuration
        ? Math.max(0, Math.min(99, (currentSec / duration) * 100))
        : null;
      const elapsedSec = (Date.now() - startedAt) / 1000;
      let etaSec = null;
      if (hasDuration && currentSec > 0.25 && elapsedSec > 0.25) {
        const rate = currentSec / elapsedSec;
        if (rate > 0) etaSec = Math.max(0, (duration - currentSec) / rate);
      }
      onProgress({
        percent,
        currentSec,
        durationSec: hasDuration ? duration : null,
        etaSec,
        elapsedSec,
      });
    };

    child.stdout.on('data', (buf) => {
      const outSec = parseProgressTimeSec(buf);
      if (outSec != null) emitProgress(outSec);
    });

    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        if (typeof onProgress === 'function') {
          onProgress({
            percent: 100,
            currentSec: durationSec || lastOutSec,
            durationSec: durationSec || null,
            etaSec: 0,
            elapsedSec: (Date.now() - startedAt) / 1000,
          });
        }
        resolve({ stderr });
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Replace dest with tmp. Windows can fail rename-over-existing if the video is
 * open (browser playback / AV scan); fall back to copy+unlink.
 */
async function replaceVideoAtomically(tmpPath, videoPath) {
  try {
    await fsPromises.rename(tmpPath, videoPath);
    return;
  } catch (renameErr) {
    console.warn(
      `[videoFps] rename failed (${renameErr.code || renameErr.message}); trying copy replace`,
    );
  }

  // Retry briefly — exclusive locks often clear once the player releases the file.
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsPromises.copyFile(tmpPath, videoPath);
      await fsPromises.unlink(tmpPath).catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw new Error(
    `Could not replace video after encode (file may be locked): ${lastErr?.message || 'unknown error'}`,
  );
}

/**
 * Re-encode a pulled MP4 to a fixed lower FPS. Duration is preserved.
 * Overwrites the original path on success.
 */
async function downsampleVideoToFps(absoluteVideoPath, targetFps, { onProgress = null } = {}) {
  const fps = normalizeVideoTargetFps(targetFps);
  if (!fps) return { changed: false, path: absoluteVideoPath };

  const videoPath = path.resolve(absoluteVideoPath);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  let currentFps = null;
  let durationSec = null;
  try {
    const meta = await probeVideoMeta(videoPath);
    currentFps = meta.fps;
    durationSec = meta.durationSec;
  } catch {
    currentFps = null;
  }
  if (currentFps != null && currentFps <= fps + 0.05) {
    return { changed: false, path: videoPath, fps: currentFps, skipped: true };
  }

  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available; cannot reduce video FPS.');
  }

  // Capture canonical date BEFORE overwrite. Prefer existing sidecar capturedAt.
  // Never use post-replace mtime — that is encode time.
  const priorStat = await fsPromises.stat(videoPath);
  const priorMeta = await readVideoMeta(videoPath);
  const sidecarLooksWrong = priorMeta?.capturedAt
    && priorMeta?.postprocessedAt
    && isCaptureTimeLikelyEncodeTime(priorMeta.capturedAt, priorMeta.postprocessedAt);
  const priorCaptureGuess = (!sidecarLooksWrong && priorMeta?.capturedAt)
    || priorStat.mtime.toISOString();
  const capturedAtIso = await ensureCapturedAt(videoPath, priorCaptureGuess);
  const capturedAt = new Date(capturedAtIso);
  const priorAtime = priorStat.atime;

  const tmpPath = `${videoPath}.fps${fps}.tmp.mp4`;
  // Drop any orphan from a previous interrupted encode.
  try {
    if (fs.existsSync(tmpPath)) await fsPromises.unlink(tmpPath);
  } catch {
    /* ignore */
  }

  try {
    await runFfmpegWithProgress(ffmpegPath, [
      '-y',
      '-i', videoPath,
      '-filter:v', `fps=${fps}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-an',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      tmpPath,
    ], { durationSec, onProgress });

    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1024) {
      throw new Error('ffmpeg FPS postprocess produced an empty file.');
    }

    await replaceVideoAtomically(tmpPath, videoPath);

    const postprocessedAt = new Date().toISOString();
    await preserveCaptureTimestamp(videoPath, {
      capturedAt: capturedAtIso,
      postprocessedAt,
      postprocess: {
        type: 'fps',
        fps,
        previousFps: currentFps,
        at: postprocessedAt,
      },
    });

    // reinforce with the pre-captured values
    try {
      await fsPromises.utimes(videoPath, priorAtime, capturedAt);
    } catch {
      /* ignore */
    }

    return {
      changed: true,
      path: videoPath,
      fps,
      previousFps: currentFps,
      durationSec,
      capturedAt: capturedAtIso,
      postprocessedAt,
      modified: capturedAtIso,
    };
  } catch (err) {
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function makeFpsJobId() {
  return `fps_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function getFpsJob(jobId) {
  return fpsJobs.get(jobId) || null;
}

function publicJobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    percent: job.percent,
    currentSec: job.currentSec,
    durationSec: job.durationSec,
    etaSec: job.etaSec,
    error: job.error || null,
    result: job.result || null,
  };
}

/**
 * Start an async FPS downsample job (for Gallery UI progress polling).
 * `@finish` receives the downsample result and should return the API payload.
 */
function startFpsDownsampleJob({
  absolutePath,
  targetFps,
  finish,
} = {}) {
  const id = makeFpsJobId();
  const job = {
    id,
    status: 'running',
    percent: 0,
    currentSec: 0,
    durationSec: null,
    etaSec: null,
    error: null,
    result: null,
    createdAt: Date.now(),
  };
  fpsJobs.set(id, job);

  (async () => {
    try {
      const downsample = await downsampleVideoToFps(absolutePath, targetFps, {
        onProgress: (p) => {
          job.percent = p.percent == null ? job.percent : p.percent;
          job.currentSec = p.currentSec;
          job.durationSec = p.durationSec;
          job.etaSec = p.etaSec;
        },
      });

      if (typeof finish === 'function') {
        job.result = await finish(downsample);
      } else {
        job.result = downsample;
      }
      job.status = 'done';
      job.percent = 100;
      job.etaSec = 0;
    } catch (err) {
      job.status = 'error';
      job.error = err.message || 'FPS postprocess failed';
    }

    // Keep a few minutes for clients to fetch the final state.
    setTimeout(() => {
      fpsJobs.delete(id);
    }, 10 * 60 * 1000).unref?.();
  })();

  return id;
}

module.exports = {
  ALLOWED_VIDEO_TARGET_FPS,
  normalizeVideoTargetFps,
  isVideoEncodeTempName,
  probeVideoFps,
  probeVideoMeta,
  downsampleVideoToFps,
  getFfmpegPath,
  startFpsDownsampleJob,
  getFpsJob,
  publicJobView,
};
