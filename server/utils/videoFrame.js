const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');

const execFileAsync = promisify(execFile);

const DEFAULT_FRAME_TIME_SEC = 0.5;

function getFfmpegPath() {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

/**
 * Extract a single JPEG frame from a video at timeSec (default 0.5s).
 * Returns { buffer, mimeType: 'image/jpeg' }.
 */
async function extractVideoFrame(absoluteVideoPath, { timeSec = DEFAULT_FRAME_TIME_SEC } = {}) {
  const videoPath = path.resolve(absoluteVideoPath);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available; cannot extract video frames.');
  }

  const seek = Number.isFinite(Number(timeSec)) && Number(timeSec) >= 0
    ? Number(timeSec)
    : DEFAULT_FRAME_TIME_SEC;

  const tmpPath = path.join(
    os.tmpdir(),
    `dininglens-frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
  );

  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-ss', String(seek),
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      tmpPath,
    ], { timeout: 60000, windowsHide: true });

    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 64) {
      throw new Error('ffmpeg did not produce a video frame.');
    }

    const buffer = await fsPromises.readFile(tmpPath);
    return { buffer, mimeType: 'image/jpeg', timeSec: seek };
  } finally {
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  DEFAULT_FRAME_TIME_SEC,
  extractVideoFrame,
  getFfmpegPath,
};
