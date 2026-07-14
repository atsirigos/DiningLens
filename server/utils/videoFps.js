const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ALLOWED_VIDEO_TARGET_FPS = [0, 1, 2, 5, 10, 15, 30];

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
  // Snap to nearest allowed positive rate
  const positives = ALLOWED_VIDEO_TARGET_FPS.filter((fps) => fps > 0);
  return positives.reduce((best, fps) => (
    Math.abs(fps - parsed) < Math.abs(best - parsed) ? fps : best
  ), positives[0]);
}

/**
 * Probe nominal video FPS from container metadata via ffmpeg (-i exit).
 * Returns a finite number or null when unknown.
 */
async function probeVideoFps(absoluteVideoPath) {
  const videoPath = path.resolve(absoluteVideoPath);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) return null;

  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', videoPath], {
      timeout: 30000,
      windowsHide: true,
    });
  } catch (err) {
    // ffmpeg exits non-zero when no output is specified; metadata is on stderr.
    stderr = String(err.stderr || err.message || '');
  }

  if (!stderr) return null;

  const videoBlock = stderr.match(/Stream #\d+:\d+(?:\([^)]*\))?: Video:[\s\S]*?(?=Stream #|\n\s*$|$)/i);
  const haystack = videoBlock ? videoBlock[0] : stderr;
  const fpsMatch = haystack.match(/(\d+(?:\.\d+)?)\s*fps/i)
    || haystack.match(/(\d+(?:\.\d+)?)\s*tbr/i);
  if (!fpsMatch) return null;

  const fps = Number(fpsMatch[1]);
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.round(fps * 100) / 100;
}

/**
 * Re-encode a pulled MP4 to a fixed lower FPS. Duration is preserved.
 * Overwrites the original path on success.
 */
async function downsampleVideoToFps(absoluteVideoPath, targetFps) {
  const fps = normalizeVideoTargetFps(targetFps);
  if (!fps) return { changed: false, path: absoluteVideoPath };

  const videoPath = path.resolve(absoluteVideoPath);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  let currentFps = null;
  try {
    currentFps = await probeVideoFps(videoPath);
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

  const tmpPath = `${videoPath}.fps${fps}.tmp.mp4`;
  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i', videoPath,
      '-filter:v', `fps=${fps}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-an',
      '-movflags', '+faststart',
      tmpPath,
    ], { timeout: 600000, windowsHide: true });

    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1024) {
      throw new Error('ffmpeg FPS postprocess produced an empty file.');
    }

    await fsPromises.rename(tmpPath, videoPath);
    return { changed: true, path: videoPath, fps, previousFps: currentFps };
  } catch (err) {
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

module.exports = {
  ALLOWED_VIDEO_TARGET_FPS,
  normalizeVideoTargetFps,
  probeVideoFps,
  downsampleVideoToFps,
  getFfmpegPath,
};
