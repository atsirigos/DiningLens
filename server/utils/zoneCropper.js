const sharp = require('sharp');
const { resolveOrientation, zoneToLandscapePixels } = require('./zoneGeometry');

/**
 * Zone coordinates are normalized (0–1) on a landscape view (wide side horizontal).
 * Orientation matches the Zones editor (portrait default + saved referenceOrientation).
 */
async function cropZoneFromImageSource(source, zone, orientationDeg = null) {
  const orientedBuffer = await sharp(source).rotate().toBuffer();
  const orientedMeta = await sharp(orientedBuffer).metadata();

  const orient = resolveOrientation(
    orientedMeta.width,
    orientedMeta.height,
    orientationDeg,
  );

  const landscapeBuffer = orient
    ? await sharp(orientedBuffer).rotate(orient).toBuffer()
    : orientedBuffer;

  const landscapeMeta = await sharp(landscapeBuffer).metadata();
  const effWidth = landscapeMeta.width;
  const effHeight = landscapeMeta.height;

  const rect = zoneToLandscapePixels(zone, effWidth, effHeight);

  if (rect.width < 8 || rect.height < 8) {
    throw new Error(`Zone "${zone.name}" crop is too small (${rect.width}×${rect.height}px)`);
  }

  const buffer = await sharp(landscapeBuffer)
    .extract(rect)
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    mimeType: 'image/jpeg',
    base64: buffer.toString('base64'),
  };
}

async function cropZoneFromPhoto(filePath, zone, orientationDeg = null) {
  return cropZoneFromImageSource(filePath, zone, orientationDeg);
}

async function cropZoneFromBuffer(buffer, zone, orientationDeg = null) {
  return cropZoneFromImageSource(buffer, zone, orientationDeg);
}

async function cropAllZones(filePath, zones, orientationDeg = null) {
  const crops = [];
  for (const zone of zones) {
    if (!zone?.name) continue;
    const image = await cropZoneFromPhoto(filePath, zone, orientationDeg);
    crops.push({ zone, image });
  }
  return crops;
}

async function cropAllZonesFromBuffer(buffer, zones, orientationDeg = null) {
  const crops = [];
  for (const zone of zones) {
    if (!zone?.name) continue;
    const image = await cropZoneFromBuffer(buffer, zone, orientationDeg);
    crops.push({ zone, image });
  }
  return crops;
}

module.exports = {
  cropZoneFromPhoto,
  cropZoneFromBuffer,
  cropAllZones,
  cropAllZonesFromBuffer,
};
