const sharp = require('sharp');
const { getEffectiveDimensions, zoneToLandscapePixels } = require('./zoneGeometry');

/**
 * Zone coordinates are normalized (0–1) on a landscape view (wide side horizontal).
 * Portrait photos are rotated 90° clockwise before cropping, matching the Zones editor.
 *
 * Apply EXIF orientation first so pixel data matches browser naturalWidth/naturalHeight.
 */
async function cropZoneFromPhoto(filePath, zone) {
  const orientedBuffer = await sharp(filePath).rotate().toBuffer();
  const orientedMeta = await sharp(orientedBuffer).metadata();

  const { width: effWidth, height: effHeight, rotated } = getEffectiveDimensions(
    orientedMeta.width,
    orientedMeta.height,
  );

  const rect = zoneToLandscapePixels(zone, effWidth, effHeight);

  if (rect.width < 8 || rect.height < 8) {
    throw new Error(`Zone "${zone.name}" crop is too small (${rect.width}×${rect.height}px)`);
  }

  const landscapeBuffer = rotated
    ? await sharp(orientedBuffer).rotate(90).toBuffer()
    : orientedBuffer;

  const buffer = await sharp(landscapeBuffer)
    .extract(rect)
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    mimeType: 'image/jpeg',
    base64: buffer.toString('base64'),
  };
}

async function cropAllZones(filePath, zones) {
  const crops = [];
  for (const zone of zones) {
    if (!zone?.name) continue;
    const image = await cropZoneFromPhoto(filePath, zone);
    crops.push({ zone, image });
  }
  return crops;
}

module.exports = { cropZoneFromPhoto, cropAllZones };
