/** Zone coordinate helpers — shared by overlay, preview crops, and server cropper. */

export function normalizeOrientation(deg) {
  const steps = ((Math.round(Number(deg) || 0) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(steps) ? steps : 0;
}

export function getDefaultOrientation(naturalWidth, naturalHeight) {
  return naturalHeight > naturalWidth ? 90 : 0;
}

export function resolveOrientation(naturalWidth, naturalHeight, orientationDeg) {
  if (orientationDeg != null && orientationDeg !== '') {
    return normalizeOrientation(orientationDeg);
  }
  return getDefaultOrientation(naturalWidth, naturalHeight);
}

export function getEffectiveDimensions(naturalWidth, naturalHeight, orientationDeg = null) {
  const orient = resolveOrientation(naturalWidth, naturalHeight, orientationDeg);
  const swap = orient === 90 || orient === 270;

  return {
    width: swap ? naturalHeight : naturalWidth,
    height: swap ? naturalWidth : naturalHeight,
    orientationDeg: orient,
    rotated: orient !== 0,
  };
}

export function zoneToLandscapePixels(zone, effWidth, effHeight) {
  return clampRect(
    {
      left: zone.x * effWidth,
      top: zone.y * effHeight,
      width: zone.width * effWidth,
      height: zone.height * effHeight,
    },
    effWidth,
    effHeight,
  );
}

export function clampRect(rect, maxW, maxH) {
  let left = Math.max(0, Math.floor(rect.left));
  let top = Math.max(0, Math.floor(rect.top));
  let width = Math.max(1, Math.round(rect.width));
  let height = Math.max(1, Math.round(rect.height));

  if (left + width > maxW) width = Math.max(1, maxW - left);
  if (top + height > maxH) height = Math.max(1, maxH - top);

  return { left, top, width, height };
}

/**
 * Build a landscape-oriented canvas from an image, matching the Zones editor transform.
 */
export function drawLandscapeCanvas(img, orientationDeg = null) {
  const orient = resolveOrientation(img.naturalWidth, img.naturalHeight, orientationDeg);
  const { width: effW, height: effH } = getEffectiveDimensions(
    img.naturalWidth,
    img.naturalHeight,
    orient,
  );

  const canvas = document.createElement('canvas');
  canvas.width = effW;
  canvas.height = effH;
  const ctx = canvas.getContext('2d');

  ctx.translate(effW / 2, effH / 2);
  ctx.rotate((orient * Math.PI) / 180);
  ctx.drawImage(
    img,
    -img.naturalWidth / 2,
    -img.naturalHeight / 2,
    img.naturalWidth,
    img.naturalHeight,
  );

  return { canvas, effW, effH };
}

/**
 * Crop a zone from an image using the same transform as the Zones editor / overlay.
 */
export function cropZoneToDataUrl(img, zone, quality = 0.9, orientationDeg = null) {
  const { canvas: landscape, effW, effH } = drawLandscapeCanvas(img, orientationDeg);
  const rect = zoneToLandscapePixels(zone, effW, effH);

  const crop = document.createElement('canvas');
  crop.width = rect.width;
  crop.height = rect.height;
  const ctx = crop.getContext('2d');
  ctx.drawImage(
    landscape,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );

  return crop.toDataURL('image/jpeg', quality);
}
