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
  const wrap = host.querySelector('.zone-orient-wrap');
  if (wrap) {
    const media = wrap.querySelector('img, video');
    if (media) {
      media.removeAttribute('style');
      host.insertBefore(media, wrap);
    }
    wrap.remove();
  }
  host.querySelector('img')?.removeAttribute('style');
  // Videos stay in-flow — never strip display styles needed for layout on clear
  // after a failed/zero-size mount; only clear styles we applied in image mounts.
}

function mediaNaturalSize(media) {
  if (!media) return { width: 0, height: 0 };
  if (media.tagName === 'VIDEO') {
    return { width: media.videoWidth || 0, height: media.videoHeight || 0 };
  }
  return { width: media.naturalWidth || 0, height: media.naturalHeight || 0 };
}

function appendZoneBoxes(layer, zones) {
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
}

/**
 * On-screen rectangle of the painted video pixels inside `host`
 * (accounts for object-fit: contain letterboxing inside the <video> element).
 */
function getVideoContentRect(host, video) {
  const hostRect = host.getBoundingClientRect();
  const el = video.getBoundingClientRect();
  const natW = video.videoWidth || 0;
  const natH = video.videoHeight || 0;
  if (!natW || !natH || !el.width || !el.height) {
    return null;
  }

  const videoAspect = natW / natH;
  const elAspect = el.width / el.height;
  let contentW;
  let contentH;

  if (videoAspect > elAspect) {
    contentW = el.width;
    contentH = el.width / videoAspect;
  } else {
    contentH = el.height;
    contentW = el.height * videoAspect;
  }

  return {
    left: el.left - hostRect.left + (el.width - contentW) / 2,
    top: el.top - hostRect.top + (el.height - contentH) / 2,
    width: contentW,
    height: contentH,
  };
}

/**
 * Overlay zones on a video without reparenting or rotating the player.
 * Zones were drawn in the rotated (landscape) editor space — keep that geometry
 * and CSS-rotate the overlay layer onto the unrotated video content box.
 */
export function mountVideoZoneOverlay(host, video, zones, orientationDeg = null) {
  host.querySelector('.zone-overlay-layer')?.remove();

  const { width: natW, height: natH } = mediaNaturalSize(video);
  if (!zones?.length || !natW || !natH || !host) return;

  host.style.position = 'relative';
  // Prefer contain so letterboxing is predictable and matches content-rect math.
  if (!video.style.objectFit) {
    video.style.objectFit = 'contain';
  }

  const content = getVideoContentRect(host, video);
  if (!content?.width || !content?.height) return;

  const { left, top, width: cw, height: ch } = content;
  const orient = resolveOrientation(natW, natH, orientationDeg);

  const layer = document.createElement('div');
  layer.className = 'zone-overlay-layer zone-overlay-layer--video';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.left = `${left}px`;
  layer.style.top = `${top}px`;
  layer.style.width = `${cw}px`;
  layer.style.height = `${ch}px`;
  layer.style.overflow = 'hidden';

  if (!orient) {
    appendZoneBoxes(layer, zones);
    host.appendChild(layer);
    return;
  }

  // Landscape plane matching the Zones editor; rotate it onto native video.
  // Editor rotates media by +orient into landscape — overlay rotates by -orient back.
  const swap = orient === 90 || orient === 270;
  const inner = document.createElement('div');
  inner.className = 'zone-overlay-rotated';
  if (swap) {
    inner.style.width = `${ch}px`;
    inner.style.height = `${cw}px`;
  } else {
    inner.style.width = `${cw}px`;
    inner.style.height = `${ch}px`;
  }
  inner.style.left = '50%';
  inner.style.top = '50%';
  inner.style.transform = `translate(-50%, -50%) rotate(${-orient}deg)`;
  appendZoneBoxes(inner, zones);
  layer.appendChild(inner);
  host.appendChild(layer);
}

/**
 * Mount zone boxes over an image inside a positioned container.
 * (Images may be reparented for orientation — videos use mountVideoZoneOverlay.)
 */
export function mountZoneOverlay(host, media, zones, orientationDeg = null) {
  if (media?.tagName === 'VIDEO') {
    mountVideoZoneOverlay(host, media, zones, orientationDeg);
    return;
  }

  clearZoneMount(host);

  const { width: natW, height: natH } = mediaNaturalSize(media);
  if (!zones?.length || !natW || !natH) return;

  host.style.position = 'relative';

  const frameW = host.clientWidth || media.clientWidth;
  const frameH = host.clientHeight || media.clientHeight || frameW / (16 / 9);
  if (!frameW || !frameH) return;

  const orient = resolveOrientation(natW, natH, orientationDeg);
  const { width: effW, height: effH } = getEffectiveDimensions(natW, natH, orient);
  const imageRect = computeImageRect(effW, effH, frameW, frameH);

  const wrap = document.createElement('div');
  wrap.className = 'zone-orient-wrap';
  wrap.style.left = `${imageRect.x}px`;
  wrap.style.top = `${imageRect.y}px`;
  wrap.style.width = `${imageRect.w}px`;
  wrap.style.height = `${imageRect.h}px`;

  if (!orient) {
    media.style.position = 'absolute';
    media.style.left = '0';
    media.style.top = '0';
    media.style.width = `${imageRect.w}px`;
    media.style.height = `${imageRect.h}px`;
    media.style.objectFit = 'fill';
    wrap.appendChild(media);
  } else {
    const inner = document.createElement('div');
    inner.className = 'zone-orient-inner';
    inner.style.width = `${imageRect.w}px`;
    inner.style.height = `${imageRect.h}px`;
    inner.style.transform = `rotate(${orient}deg)`;

    if (orient === 90 || orient === 270) {
      media.style.width = `${imageRect.h}px`;
      media.style.height = `${imageRect.w}px`;
    } else {
      media.style.width = `${imageRect.w}px`;
      media.style.height = `${imageRect.h}px`;
    }
    media.style.display = 'block';
    media.style.objectFit = 'fill';

    inner.appendChild(media);
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
  appendZoneBoxes(layer, zones);
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
