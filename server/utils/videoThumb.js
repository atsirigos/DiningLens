const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { rotateImageFile } = require('./imageRotate');
const { getSettings } = require('../db/settingsStore');

const execFileAsync = promisify(execFile);

function getFfmpegPath() {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

function thumbPathForVideo(videoPath) {
  return String(videoPath || '').replace(/\.(mp4|mov)$/i, '.thumb.jpg');
}

function isVideoThumbName(filename) {
  return /\.thumb\.(jpe?g|png|webp)$/i.test(String(filename || ''));
}

/**
 * Extract a still from a video and apply the same phone.frameRotation used for photos.
 * Writes `<videoBase>.thumb.jpg` next to the clip. Returns the thumb absolute path.
 */
async function generateVideoThumbnail(absoluteVideoPath, { force = false } = {}) {
  const videoPath = path.resolve(absoluteVideoPath);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  const thumbPath = thumbPathForVideo(videoPath);
  if (!force && fs.existsSync(thumbPath)) {
    return thumbPath;
  }

  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available; cannot generate video thumbnails.');
  }

  const tmpPath = `${thumbPath}.tmp.jpg`;
  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-ss', '0.3',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '3',
      tmpPath,
    ], { timeout: 60000, windowsHide: true });

    if (!fs.existsSync(tmpPath)) {
      throw new Error('ffmpeg did not produce a thumbnail frame.');
    }

    await fsPromises.rename(tmpPath, thumbPath);

    const frameRotation = getSettings().phone?.frameRotation || 0;
    if (frameRotation) {
      await rotateImageFile(thumbPath, frameRotation);
    }

    return thumbPath;
  } catch (err) {
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function ensureVideoThumbnail(absoluteVideoPath) {
  const thumbPath = thumbPathForVideo(absoluteVideoPath);
  if (fs.existsSync(thumbPath)) return thumbPath;
  return generateVideoThumbnail(absoluteVideoPath);
}

module.exports = {
  thumbPathForVideo,
  isVideoThumbName,
  generateVideoThumbnail,
  ensureVideoThumbnail,
};
