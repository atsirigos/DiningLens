const sharp = require('sharp');

/**
 * Zone coordinates are normalized (0–1) on a landscape view (wide side horizontal).
 * Portrait photos are rotated 90° clockwise before cropping, matching the Zones editor.
 */
async function cropZoneFromPhoto(filePath, zone) {
  const meta = await sharp(filePath).metadata();
  const rotated = meta.height > meta.width;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  const left = Math.max(0, Math.round(zone.x * width));
  const top = Math.max(0, Math.round(zone.y * height));
  const cropW = Math.min(width - left, Math.round(zone.width * width));
  const cropH = Math.min(height - top, Math.round(zone.height * height));

  if (cropW < 8 || cropH < 8) {
    throw new Error(`Zone "${zone.name}" crop is too small (${cropW}×${cropH}px)`);
  }

  let pipeline = sharp(filePath);
  if (rotated) {
    pipeline = pipeline.rotate(-90);
  }

  const buffer = await pipeline
    .extract({ left, top, width: cropW, height: cropH })
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
