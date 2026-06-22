/** Zone coordinate helpers — keep in sync with public/scripts/zoneGeometry.js */

function getEffectiveDimensions(width, height) {
  if (height > width) {
    return { width: height, height: width, rotated: true };
  }
  return { width, height, rotated: false };
}

function clampRect(rect, maxW, maxH) {
  let left = Math.max(0, Math.floor(rect.left));
  let top = Math.max(0, Math.floor(rect.top));
  let width = Math.max(1, Math.round(rect.width));
  let height = Math.max(1, Math.round(rect.height));

  if (left + width > maxW) width = Math.max(1, maxW - left);
  if (top + height > maxH) height = Math.max(1, maxH - top);

  return { left, top, width, height };
}

function zoneToLandscapePixels(zone, effWidth, effHeight) {
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

module.exports = {
  getEffectiveDimensions,
  clampRect,
  zoneToLandscapePixels,
};
