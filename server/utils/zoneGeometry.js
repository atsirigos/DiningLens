/** Zone coordinate helpers — keep in sync with public/scripts/zoneGeometry.js */

const { normalizeOrientation } = require('./imageRotate');

function getDefaultOrientation(width, height) {
  return height > width ? 90 : 0;
}

function resolveOrientation(width, height, orientationDeg) {
  if (orientationDeg != null && orientationDeg !== '') {
    return normalizeOrientation(orientationDeg);
  }
  return getDefaultOrientation(width, height);
}

function getEffectiveDimensions(width, height, orientationDeg = null) {
  const orient = resolveOrientation(width, height, orientationDeg);
  const swap = orient === 90 || orient === 270;

  return {
    width: swap ? height : width,
    height: swap ? width : height,
    orientationDeg: orient,
    rotated: orient !== 0,
  };
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
  getDefaultOrientation,
  resolveOrientation,
  getEffectiveDimensions,
  clampRect,
  zoneToLandscapePixels,
};
