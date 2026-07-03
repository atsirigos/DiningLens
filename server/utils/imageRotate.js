const fs = require('fs/promises');
const sharp = require('sharp');

function normalizeOrientation(deg) {
  const steps = ((Math.round(Number(deg) || 0) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(steps) ? steps : 0;
}

/**
 * Normalize EXIF orientation, apply user rotation, and overwrite the file in place.
 */
async function rotateImageFile(filePath, degrees) {
  const deg = normalizeOrientation(degrees);
  const tmpPath = `${filePath}.rotate-tmp`;

  let pipeline = sharp(filePath).rotate();
  if (deg !== 0) {
    pipeline = pipeline.rotate(deg);
  }

  await pipeline.toFile(tmpPath);
  await fs.rename(tmpPath, filePath);
}

module.exports = {
  normalizeOrientation,
  rotateImageFile,
};
