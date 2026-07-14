const path = require('path');
const fs = require('fs');
const express = require('express');
const { scanDataFolder } = require('../utils/fileScanner');
const { getSettings } = require('../db/settingsStore');
const { cropZoneFromPhoto, cropZoneFromBuffer } = require('../utils/zoneCropper');
const { rotateImageFile, normalizeOrientation } = require('../utils/imageRotate');
const { thumbPathForVideo, ensureVideoThumbnail, generateVideoThumbnail } = require('../utils/videoThumb');
const { extractVideoFrame, DEFAULT_FRAME_TIME_SEC } = require('../utils/videoFrame');
const {
  ALLOWED_VIDEO_TARGET_FPS,
  normalizeVideoTargetFps,
  probeVideoFps,
  probeVideoMeta,
  startFpsDownsampleJob,
  getFpsJob,
  publicJobView,
} = require('../utils/videoFps');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/** @type {Map<string, { mtimeMs: number, size: number, fps: number|null }>} */
const videoFpsCache = new Map();

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov']);

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function resolveSafePath(filename) {
  let raw = filename;
  if (Array.isArray(raw)) {
    raw = raw.map(String).join('/');
  }
  const decoded = decodeURIComponent(String(raw || ''));
  const resolved = path.resolve(DATA_DIR, decoded);
  const normalizedData = path.resolve(DATA_DIR);

  if (!resolved.startsWith(normalizedData + path.sep) && resolved !== normalizedData) {
    return null;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return null;
  }

  return resolved;
}

async function resolveVideoFps(absVideo, cacheKey) {
  let stat;
  try {
    stat = fs.statSync(absVideo);
  } catch {
    return null;
  }

  const cached = videoFpsCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.fps;
  }

  let fps = null;
  try {
    fps = await probeVideoFps(absVideo);
  } catch (err) {
    console.warn(`[files] video fps probe failed for ${cacheKey}:`, err.message);
  }

  videoFpsCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, fps });
  return fps;
}

async function attachVideoMeta(files) {
  const enriched = [];
  for (const file of files) {
    if (file.type !== 'video') {
      enriched.push(file);
      continue;
    }

    const absVideo = path.join(DATA_DIR, file.path);
    const thumbRel = thumbPathForVideo(file.path).split(path.sep).join('/');
    const absThumb = path.join(DATA_DIR, thumbRel);

    if (!fs.existsSync(absThumb)) {
      try {
        await ensureVideoThumbnail(absVideo);
      } catch (err) {
        console.warn(`[files] video thumb failed for ${file.path}:`, err.message);
      }
    }

    const fps = await resolveVideoFps(absVideo, file.path);

    enriched.push({
      ...file,
      thumbPath: fs.existsSync(absThumb) ? thumbRel : null,
      fps,
    });
  }
  return enriched;
}

router.get('/files', async (req, res) => {
  try {
    const files = scanDataFolder(DATA_DIR);
    const withMeta = await attachVideoMeta(files);
    res.json(withMeta);
  } catch (err) {
    res.status(500).json({ error: 'Failed to scan data folder' });
  }
});

router.get('/zone-crop', async (req, res) => {
  try {
    const { file, zone } = req.query;
    if (!file || !zone) {
      return res.status(400).json({ error: 'file and zone query parameters are required' });
    }

    const filePath = resolveSafePath(file);
    if (!filePath) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);
    if (!isImage && !isVideo) {
      return res.status(400).json({ error: 'Zone crops are only available for images and videos' });
    }

    const zoneName = decodeURIComponent(zone);
    const settings = getSettings();
    const zoneList = isVideo ? (settings.videoZones || []) : (settings.zones || []);
    const orientation = isVideo
      ? settings.referenceVideoOrientation
      : settings.referenceOrientation;
    const zoneConfig = zoneList.find((entry) => entry.name === zoneName);
    if (!zoneConfig) {
      return res.status(404).json({
        error: `Zone "${zoneName}" not found in ${isVideo ? 'video' : 'photo'} zones`,
      });
    }

    let image;
    if (isVideo) {
      const requested = Number(req.query.timeSec);
      const timeSec = Number.isFinite(requested) && requested >= 0
        ? requested
        : DEFAULT_FRAME_TIME_SEC;
      const { buffer } = await extractVideoFrame(filePath, { timeSec });
      image = await cropZoneFromBuffer(buffer, zoneConfig, orientation);
    } else {
      image = await cropZoneFromPhoto(filePath, zoneConfig, orientation);
    }

    const out = Buffer.from(image.base64, 'base64');
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(out);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to crop zone' });
  }
});

router.get('/video-frame', async (req, res) => {
  try {
    const { file } = req.query;
    if (!file) {
      return res.status(400).json({ error: 'file query parameter is required' });
    }

    const filePath = resolveSafePath(file);
    if (!filePath) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) {
      return res.status(400).json({ error: 'video-frame is only available for videos' });
    }

    const requested = Number(req.query.timeSec);
    const timeSec = Number.isFinite(requested) && requested >= 0
      ? requested
      : DEFAULT_FRAME_TIME_SEC;

    const { buffer, mimeType } = await extractVideoFrame(filePath, { timeSec });
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Frame-Time-Sec', String(timeSec));
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to extract video frame' });
  }
});

router.post('/files/rotate', async (req, res) => {
  try {
    const { path: filePath, degrees } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ error: 'path is required' });
    }

    const resolved = resolveSafePath(filePath);
    if (!resolved) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      return res.status(400).json({ error: 'Only image files can be rotated' });
    }

    const rotation = normalizeOrientation(degrees ?? 90);
    if (rotation === 0) {
      return res.status(400).json({ error: 'degrees must be 90, 180, or 270' });
    }

    await rotateImageFile(resolved, rotation);
    res.json({ success: true, path: filePath, degrees: rotation });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to rotate image' });
  }
});

router.post('/files/video-fps', async (req, res) => {
  try {
    const { path: filePath, targetFps } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ error: 'path is required' });
    }

    const resolved = resolveSafePath(filePath);
    if (!resolved) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!['.mp4', '.mov'].includes(ext)) {
      return res.status(400).json({ error: 'Only video files can be FPS-postprocessed' });
    }

    const fps = normalizeVideoTargetFps(targetFps);
    if (!fps) {
      return res.status(400).json({
        error: `targetFps must be one of: ${ALLOWED_VIDEO_TARGET_FPS.filter((n) => n > 0).join(', ')}`,
      });
    }

    let currentFps = null;
    try {
      currentFps = (await probeVideoMeta(resolved)).fps;
    } catch {
      currentFps = null;
    }
    if (currentFps != null && currentFps <= fps + 0.05) {
      const stat = fs.statSync(resolved);
      videoFpsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, fps: currentFps });
      return res.json({
        success: true,
        changed: false,
        skipped: true,
        path: filePath,
        fps: currentFps,
        size: stat.size,
        message: `Clip is already at ${currentFps} fps or lower.`,
      });
    }

    const jobId = startFpsDownsampleJob({
      absolutePath: resolved,
      targetFps: fps,
      finish: async (downsample) => {
        try {
          await generateVideoThumbnail(resolved, { force: true });
        } catch (err) {
          console.warn(`[files] video thumb refresh failed for ${filePath}:`, err.message);
        }

        const stat = fs.statSync(resolved);
        const probed = downsample.changed ? fps : await resolveVideoFps(resolved, filePath);
        videoFpsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, fps: probed });

        const thumbRel = thumbPathForVideo(filePath).split(path.sep).join('/');
        const absThumb = path.join(DATA_DIR, thumbRel);

        return {
          success: true,
          changed: !!downsample.changed,
          skipped: !!downsample.skipped,
          path: filePath,
          fps: probed,
          previousFps: downsample.previousFps ?? null,
          size: stat.size,
          // Capture time is canonical; never report re-encode mtime as capture.
          modified: downsample.capturedAt || downsample.modified || stat.mtime.toISOString(),
          capturedAt: downsample.capturedAt || downsample.modified || stat.mtime.toISOString(),
          postprocessedAt: downsample.postprocessedAt || null,
          thumbPath: fs.existsSync(absThumb) ? thumbRel : null,
        };
      },
    });

    res.status(202).json({
      success: true,
      async: true,
      jobId,
      path: filePath,
      targetFps: fps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to reduce video FPS' });
  }
});

router.get('/files/video-fps/jobs/:jobId', (req, res) => {
  const job = getFpsJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(publicJobView(job));
});

router.get('/file/*filepath', (req, res) => {
  const filename = req.params.filepath;
  const filePath = resolveSafePath(filename);

  if (!filePath) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  // Range support is required for MP4s with moov-at-end (screenrecord output)
  res.sendFile(filePath, { acceptRanges: true }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Failed to send file' });
    }
  });
});

module.exports = router;
