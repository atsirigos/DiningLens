const fs = require('node:fs');
const path = require('node:path');
const fsPromises = require('node:fs/promises');
const sharp = require('sharp');
const { analyzeImageList } = require('./aiWrapper');
const { cropZoneFromBuffer } = require('./zoneCropper');
const { mergeZoneResults } = require('./mergeZoneResults');
const { extractVideoFrame } = require('./videoFrame');
const { probeVideoMeta, isVideoEncodeTempName } = require('./videoFps');
const { isVideoThumbName } = require('./videoThumb');
const { isVideoMetaName, readVideoMeta } = require('./videoMeta');

const MAX_TIMELAPSE_FRAMES = 12;
const MAX_LONG_EDGE = 1024;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov']);

function sampleIndices(count, maxCount) {
  if (count <= 0 || maxCount <= 0) return [];
  if (count <= maxCount) return Array.from({ length: count }, (_, i) => i);
  if (maxCount === 1) return [0];
  const last = count - 1;
  const middle = Math.round(last / 2);
  const indices = [];
  for (let i = 0; i < maxCount; i += 1) {
    indices.push(Math.round((i * last) / (maxCount - 1)));
  }
  if (!indices.includes(middle)) {
    let replaceAt = 1;
    let bestDist = Infinity;
    for (let i = 1; i < indices.length - 1; i += 1) {
      const dist = Math.abs(indices[i] - middle);
      if (dist < bestDist) {
        bestDist = dist;
        replaceAt = i;
      }
    }
    indices[replaceAt] = middle;
  }
  return [...new Set(indices)].sort((a, b) => a - b);
}

async function limitLongEdge(source) {
  const rotated = await sharp(source).rotate().toBuffer();
  return sharp(rotated)
    .resize(MAX_LONG_EDGE, MAX_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function listSessionMedia(absDir, mealKey) {
  const names = await fsPromises.readdir(absDir);
  const images = [];
  const videos = [];

  for (const name of names) {
    if (isVideoThumbName(name) || isVideoMetaName(name) || isVideoEncodeTempName(name)) continue;
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue;

    const abs = path.join(absDir, name);
    const stat = await fsPromises.stat(abs);
    if (!stat.isFile()) continue;

    let sortAt = stat.mtimeMs;
    if (VIDEO_EXTS.has(ext)) {
      const meta = await readVideoMeta(abs);
      const captured = Date.parse(meta?.capturedAt);
      if (Number.isFinite(captured)) sortAt = captured;
    }

    const entry = {
      abs,
      name,
      sortAt,
      relativePath: path.posix.join(mealKey, name),
      type: VIDEO_EXTS.has(ext) ? 'video' : 'image',
    };
    if (entry.type === 'video') videos.push(entry);
    else images.push(entry);
  }

  const byOrder = (a, b) => a.sortAt - b.sortAt || a.name.localeCompare(b.name);
  images.sort(byOrder);
  videos.sort(byOrder);

  if (images.length) return { mode: 'timelapse', files: images };
  return { mode: 'video', files: videos };
}

async function frameFromVideo(file) {
  let durationSec = null;
  try {
    durationSec = (await probeVideoMeta(file.abs)).durationSec;
  } catch {
    durationSec = null;
  }
  const timeSec = Number.isFinite(durationSec) && durationSec > 0.2
    ? durationSec / 2
    : 0.5;
  const extracted = await extractVideoFrame(file.abs, { timeSec });
  const buffer = await limitLongEdge(extracted.buffer);
  return {
    buffer,
    timeSec,
    file: file.relativePath,
  };
}

async function frameFromImage(file) {
  const buffer = await limitLongEdge(file.abs);
  return {
    buffer,
    timeSec: null,
    file: file.relativePath,
  };
}

async function chooseFrames(mode, files) {
  if (mode === 'video') {
    const frames = [];
    for (const file of files) {
      frames.push(await frameFromVideo(file));
    }
    return frames;
  }

  const indexes = sampleIndices(files.length, MAX_TIMELAPSE_FRAMES);
  const frames = [];
  for (const index of indexes) {
    frames.push(await frameFromImage(files[index]));
  }
  return frames;
}

function toImage(buffer) {
  return {
    mimeType: 'image/jpeg',
    base64: buffer.toString('base64'),
  };
}

async function analyzeMealDirectory(absDir, mealKey, settings, userContext) {
  if (!absDir || !fs.existsSync(absDir)) {
    throw new Error('Meal folder not found');
  }

  const { mode, files } = await listSessionMedia(absDir, mealKey);
  if (!files.length) {
    throw new Error('This meal has no frames to analyze');
  }

  const frames = await chooseFrames(mode, files);
  const isVideo = mode === 'video';
  const zones = ((isVideo ? settings?.videoZones : settings?.zones) || []).filter((zone) => zone?.name);
  const orientation = isVideo ? settings?.referenceVideoOrientation : settings?.referenceOrientation;
  const filename = mealKey;

  let result;
  if (!zones.length) {
    result = await analyzeImageList(
      frames.map((frame) => toImage(frame.buffer)),
      settings,
      userContext,
      { filename },
    );
  } else {
    const zoneResults = [];
    for (const zone of zones) {
      const images = [];
      for (const frame of frames) {
        const crop = await cropZoneFromBuffer(frame.buffer, zone, orientation);
        images.push({ mimeType: crop.mimeType, base64: crop.base64 });
      }
      const zoneResult = await analyzeImageList(images, settings, userContext, {
        filename,
        zoneName: zone.name,
      });
      zoneResults.push({ zoneName: zone.name, result: zoneResult });
    }
    result = mergeZoneResults(zoneResults);
  }

  return {
    ...result,
    mediaType: 'meal',
    captureMode: mode,
    frameCount: frames.length,
    sourceCount: files.length,
    frames: frames.map((frame) => ({
      file: frame.file,
      ...(frame.timeSec != null ? { timeSec: frame.timeSec } : {}),
    })),
  };
}

module.exports = {
  MAX_TIMELAPSE_FRAMES,
  sampleIndices,
  analyzeMealDirectory,
};
