/** Shared zone layout helpers — matches the Zones editor display logic. */

import {
  getEffectiveDimensions,
  resolveOrientation,
} from './zoneGeometry.js';

export {
  getEffectiveDimensions,
  resolveOrientation,
  normalizeOrientation,
  getDefaultOrientation,
} from './zoneGeometry.js';

export function computeImageRect(effW, effH, frameW, frameH) {
  const frameAspect = frameW / frameH;
  const imgAspect = effW / effH;
  let drawW;
  let drawH;

  if (imgAspect > frameAspect) {
    drawW = frameW;
    drawH = frameW / imgAspect;
  } else {
    drawH = frameH;
    drawW = frameH * imgAspect;
  }

  return {
    x: (frameW - drawW) / 2,
    y: (frameH - drawH) / 2,
    w: drawW,
    h: drawH,
  };
}

function clearZoneMount(host) {
  host.querySelector('.zone-overlay-layer')?.remove();
  host.querySelector('.zone-orient-wrap')?.remove();
  const img = host.querySelector('img');
  if (img) img.removeAttribute('style');
}

/**
 * Mount zone boxes over an image inside a positioned container.
 */
export function mountZoneOverlay(host, img, zones, orientationDeg = null) {
  clearZoneMount(host);

  if (!zones?.length || !img.naturalWidth) return;

  host.style.position = 'relative';

  const frameW = host.clientWidth || img.clientWidth;
  const frameH = host.clientHeight || img.clientHeight || frameW / (16 / 9);
  const orient = resolveOrientation(img.naturalWidth, img.naturalHeight, orientationDeg);
  const { width: effW, height: effH } = getEffectiveDimensions(
    img.naturalWidth,
    img.naturalHeight,
    orient,
  );
  const imageRect = computeImageRect(effW, effH, frameW, frameH);

  const wrap = document.createElement('div');
  wrap.className = 'zone-orient-wrap';
  wrap.style.left = `${imageRect.x}px`;
  wrap.style.top = `${imageRect.y}px`;
  wrap.style.width = `${imageRect.w}px`;
  wrap.style.height = `${imageRect.h}px`;

  if (!orient) {
    img.style.position = 'absolute';
    img.style.left = '0';
    img.style.top = '0';
    img.style.width = `${imageRect.w}px`;
    img.style.height = `${imageRect.h}px`;
    img.style.objectFit = 'fill';
    wrap.appendChild(img);
  } else {
    const inner = document.createElement('div');
    inner.className = 'zone-orient-inner';
    inner.style.width = `${imageRect.w}px`;
    inner.style.height = `${imageRect.h}px`;
    inner.style.transform = `rotate(${orient}deg)`;

    if (orient === 90 || orient === 270) {
      img.style.width = `${imageRect.h}px`;
      img.style.height = `${imageRect.w}px`;
    } else {
      img.style.width = `${imageRect.w}px`;
      img.style.height = `${imageRect.h}px`;
    }
    img.style.display = 'block';
    img.style.objectFit = 'fill';

    inner.appendChild(img);
    wrap.appendChild(inner);
  }

  host.appendChild(wrap);

  const layer = document.createElement('div');
  layer.className = 'zone-overlay-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.left = `${imageRect.x}px`;
  layer.style.top = `${imageRect.y}px`;
  layer.style.width = `${imageRect.w}px`;
  layer.style.height = `${imageRect.h}px`;

  zones.forEach((zone) => {
    const box = document.createElement('div');
    box.className = 'zone-overlay-box';
    box.dataset.zoneName = zone.name;
    box.style.left = `${zone.x * 100}%`;
    box.style.top = `${zone.y * 100}%`;
    box.style.width = `${zone.width * 100}%`;
    box.style.height = `${zone.height * 100}%`;

    const label = document.createElement('span');
    label.className = 'zone-overlay-label';
    label.textContent = zone.name;
    box.appendChild(label);
    layer.appendChild(box);
  });

  host.appendChild(layer);
}

export function highlightZoneOverlay(host, zoneName) {
  if (!host) return;

  const boxes = host.querySelectorAll('.zone-overlay-box');
  if (!boxes.length) return;

  if (!zoneName) {
    boxes.forEach((box) => {
      box.classList.remove('zone-overlay-box--active', 'zone-overlay-box--dimmed');
    });
    return;
  }

  boxes.forEach((box) => {
    const isActive = box.dataset.zoneName === zoneName;
    box.classList.toggle('zone-overlay-box--active', isActive);
    box.classList.toggle('zone-overlay-box--dimmed', !isActive);
  });
}
