const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');

/**
 * Sidecar next to a video clip: preserves capture time across re-encodes and
 * records post-processing history without relying on filesystem mtime alone.
 */
function metaPathForVideo(absoluteVideoPath) {
  return String(absoluteVideoPath || '').replace(/\.(mp4|mov)$/i, '.meta.json');
}

function isVideoMetaName(filename) {
  return /\.meta\.json$/i.test(String(filename || ''));
}

/**
 * True when capturedAt was almost certainly written as encode-time by mistake
 * (within a minute of postprocessedAt).
 */
function isCaptureTimeLikelyEncodeTime(capturedAt, postprocessedAt) {
  const cap = Date.parse(capturedAt);
  const post = Date.parse(postprocessedAt);
  if (!Number.isFinite(cap) || !Number.isFinite(post)) return false;
  return Math.abs(cap - post) < 60_000;
}

async function readVideoMeta(absoluteVideoPath) {
  const metaPath = metaPathForVideo(absoluteVideoPath);
  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeVideoMeta(absoluteVideoPath, patch = {}, { forceCapturedAt = false } = {}) {
  const metaPath = metaPathForVideo(absoluteVideoPath);
  const existing = (await readVideoMeta(absoluteVideoPath)) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  // Original capture time is canonical — never replace once recorded (unless forced heal).
  if (existing.capturedAt && !forceCapturedAt) {
    next.capturedAt = existing.capturedAt;
  }
  await fsPromises.writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Lock capture time onto the sidecar before any re-encode mutates mtime.
 * Safe to call repeatedly; will not overwrite a good capturedAt.
 */
async function ensureCapturedAt(absoluteVideoPath, capturedAtIso) {
  const videoPath = path.resolve(absoluteVideoPath);
  const existing = await readVideoMeta(videoPath);
  const known = new Date(capturedAtIso).toISOString();
  const looksWrong = existing?.capturedAt
    && existing?.postprocessedAt
    && isCaptureTimeLikelyEncodeTime(existing.capturedAt, existing.postprocessedAt);

  if (existing?.capturedAt && !looksWrong) {
    return existing.capturedAt;
  }

  await writeVideoMeta(videoPath, { capturedAt: known }, { forceCapturedAt: looksWrong });
  return known;
}

/**
 * Ensure capturedAt is set (never overwritten once present, unless healing a
 * known bad encode-time value) and restore FS mtime to that capture time.
 *
 * Always pass `capturedAt` taken BEFORE the file was replaced — post-replace
 * mtime is encode-time and must not become capturedAt.
 */
async function preserveCaptureTimestamp(absoluteVideoPath, {
  capturedAt: knownCapturedAt = null,
  postprocessedAt = null,
  postprocess = null,
} = {}) {
  const videoPath = path.resolve(absoluteVideoPath);
  const before = await fsPromises.stat(videoPath);
  const existing = await readVideoMeta(videoPath);
  const knownIso = knownCapturedAt
    ? new Date(knownCapturedAt).toISOString()
    : null;

  let capturedAtIso = existing?.capturedAt || null;
  let forceCapturedAt = false;

  const looksWrong = capturedAtIso
    && (postprocessedAt || existing?.postprocessedAt)
    && isCaptureTimeLikelyEncodeTime(
      capturedAtIso,
      postprocessedAt || existing.postprocessedAt,
    );

  if (looksWrong && knownIso) {
    capturedAtIso = knownIso;
    forceCapturedAt = true;
  } else if (!capturedAtIso) {
    // Prefer caller-provided pre-replace time — never invent from post-replace mtime
    // when knownCapturedAt was supplied.
    capturedAtIso = knownIso || before.mtime.toISOString();
  }

  const capturedAt = new Date(capturedAtIso);

  await writeVideoMeta(videoPath, {
    capturedAt: capturedAtIso,
    ...(postprocessedAt ? { postprocessedAt } : {}),
    ...(postprocess ? { lastPostprocess: postprocess } : {}),
  }, { forceCapturedAt });

  try {
    await fsPromises.utimes(videoPath, before.atime, capturedAt);
  } catch (err) {
    console.warn(`[videoMeta] failed to restore mtime for ${videoPath}:`, err.message);
  }

  try {
    await fsPromises.utimes(metaPathForVideo(videoPath), capturedAt, capturedAt);
  } catch {
    /* ignore */
  }

  return {
    capturedAt: capturedAtIso,
    postprocessedAt: postprocessedAt || existing?.postprocessedAt || null,
  };
}

module.exports = {
  metaPathForVideo,
  isVideoMetaName,
  isCaptureTimeLikelyEncodeTime,
  readVideoMeta,
  writeVideoMeta,
  ensureCapturedAt,
  preserveCaptureTimestamp,
};
