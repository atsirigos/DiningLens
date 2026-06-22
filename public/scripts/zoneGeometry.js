/** Zone coordinate helpers — shared by overlay, preview crops, and server cropper. */

export function getEffectiveDimensions(naturalWidth, naturalHeight) {
  if (naturalHeight > naturalWidth) {
    return { width: naturalHeight, height: naturalWidth, rotated: true };
  }
  return { width: naturalWidth, height: naturalHeight, rotated: false };
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
export function drawLandscapeCanvas(img) {
  const { width: effW, height: effH, rotated } = getEffectiveDimensions(
    img.naturalWidth,
    img.naturalHeight,
  );

  const canvas = document.createElement('canvas');
  canvas.width = effW;
  canvas.height = effH;
  const ctx = canvas.getContext('2d');

  if (rotated) {
    ctx.translate(effW, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0, effH, effW);
  } else {
    ctx.drawImage(img, 0, 0, effW, effH);
  }

  return { canvas, effW, effH };
}

/**
 * Crop a zone from an image using the same transform as the Zones editor / overlay.
 */
export function cropZoneToDataUrl(img, zone, quality = 0.9) {
  const { canvas: landscape, effW, effH } = drawLandscapeCanvas(img);
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
