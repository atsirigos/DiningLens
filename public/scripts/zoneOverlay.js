/** Shared zone layout helpers — matches the Zones editor display logic. */

export function getEffectiveDimensions(naturalWidth, naturalHeight) {
  if (naturalHeight > naturalWidth) {
    return { width: naturalHeight, height: naturalWidth, rotated: true };
  }
  return { width: naturalWidth, height: naturalHeight, rotated: false };
}

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
  const rotWrap = host.querySelector('.zone-rot-wrap');
  if (rotWrap) {
    const img = rotWrap.querySelector('img');
    if (img) host.insertBefore(img, rotWrap);
    rotWrap.remove();
  }
  const img = host.querySelector('img');
  if (img) {
    img.removeAttribute('style');
  }
}

/**
 * Mount zone boxes over an image inside a positioned container.
 * Portrait images are rotated to match the Zones editor (wide side horizontal).
 */
export function mountZoneOverlay(host, img, zones) {
  clearZoneMount(host);

  if (!zones?.length || !img.naturalWidth) return;

  host.style.position = 'relative';

  const frameW = host.clientWidth || img.clientWidth;
  const frameH = host.clientHeight || img.clientHeight || frameW / (16 / 9);
  const { width: effW, height: effH, rotated } = getEffectiveDimensions(img.naturalWidth, img.naturalHeight);
  const imageRect = computeImageRect(effW, effH, frameW, frameH);

  if (rotated) {
    const rotWrap = document.createElement('div');
    rotWrap.className = 'zone-rot-wrap';
    rotWrap.style.left = `${imageRect.x + imageRect.w}px`;
    rotWrap.style.top = `${imageRect.y}px`;
    host.insertBefore(rotWrap, img);
    rotWrap.appendChild(img);
    img.style.width = `${imageRect.h}px`;
    img.style.height = `${imageRect.w}px`;
    img.style.display = 'block';
  } else {
    img.style.position = 'absolute';
    img.style.left = `${imageRect.x}px`;
    img.style.top = `${imageRect.y}px`;
    img.style.width = `${imageRect.w}px`;
    img.style.height = `${imageRect.h}px`;
    img.style.objectFit = 'fill';
  }

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
