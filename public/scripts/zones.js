import { apiFetch, showToast } from './utils.js';
import {
  getEffectiveDimensions,
  resolveOrientation,
  getDefaultOrientation,
  normalizeOrientation,
} from './zoneGeometry.js';

const MODE_PHOTO = 'photo';
const MODE_VIDEO = 'video';

let settings = {};
let files = [];
let editorMode = MODE_PHOTO;
let canvas, ctx, img;
let drawing = false;
let startX, startY;
let currentRect = null;
let imageRect = { x: 0, y: 0, w: 0, h: 0 };
let baseImageRect = { x: 0, y: 0, w: 0, h: 0 };
let orientationDeg = 0;
let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;
let panning = false;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;
let spaceHeld = false;
let editorEventsBound = false;

const LANDSCAPE_ASPECT = 16 / 9;
const CANVAS_MAX_WIDTH = 900;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

const container = () => document.getElementById('zones-content');

function fileRef(f) {
  return f.path || f.name;
}

function fileLabel(f) {
  return f.path && f.path !== f.name ? f.path : f.name;
}

function isVideoMode() {
  return editorMode === MODE_VIDEO;
}

function getActiveZones() {
  return isVideoMode() ? (settings.videoZones || []) : (settings.zones || []);
}

function setActiveZones(zones) {
  if (isVideoMode()) settings.videoZones = zones;
  else settings.zones = zones;
}

function getReference() {
  return isVideoMode() ? settings.referenceVideo : settings.referenceImage;
}

function setReference(value) {
  if (isVideoMode()) settings.referenceVideo = value;
  else settings.referenceImage = value;
}

function getStoredOrientation() {
  return isVideoMode()
    ? settings.referenceVideoOrientation
    : settings.referenceOrientation;
}

function setStoredOrientation(value) {
  if (isVideoMode()) settings.referenceVideoOrientation = value;
  else settings.referenceOrientation = value;
}

function resolveReferenceMedia(savedRef, mediaFiles) {
  if (!savedRef) return null;
  const exact = mediaFiles.find((f) => fileRef(f) === savedRef);
  if (exact) return fileRef(exact);
  const byName = mediaFiles.filter((f) => f.name === savedRef);
  if (byName.length === 1) return fileRef(byName[0]);
  return null;
}

function mediaFilesForMode() {
  return files.filter((f) => f.type === (isVideoMode() ? 'video' : 'image'));
}

function syncPanelHeader() {
  const panel = document.getElementById('panel-zones');
  const sub = panel?.querySelector('.panel-header p');
  if (!sub) return;
  sub.textContent = isVideoMode()
    ? 'Define zones on a reference video frame — the same layout applies to every video from this camera'
    : 'Define zones on a reference photo — the same layout applies to every photo from this camera';
}

function render() {
  const mediaFiles = mediaFilesForMode();
  const reference = getReference();
  const zones = getActiveZones();
  const mediaNoun = isVideoMode() ? 'videos' : 'photos';
  const mediaSingular = isVideoMode() ? 'video' : 'image';

  container().innerHTML = `
    <div class="settings-grid">
      <div class="card">
        <h3>Zone Editor</h3>
        <div class="toggle-group zone-modality-toggle" id="zone-modality-toggle" style="margin-top: 1rem;">
          <button type="button" data-mode="${MODE_PHOTO}" class="${editorMode === MODE_PHOTO ? 'active' : ''}">Photos</button>
          <button type="button" data-mode="${MODE_VIDEO}" class="${editorMode === MODE_VIDEO ? 'active' : ''}">Videos</button>
        </div>
        <div class="form-group" style="margin-top: 1rem;">
          <label for="ref-media-select">${isVideoMode() ? 'Reference Video' : 'Reference Image'}</label>
          <select id="ref-media-select">
            <option value="">Select a ${mediaSingular}...</option>
            ${mediaFiles.map((f) => `
              <option value="${fileRef(f)}" ${reference === fileRef(f) ? 'selected' : ''}>${fileLabel(f)}</option>
            `).join('')}
          </select>
        </div>
        <div class="zone-editor-toolbar" id="zone-editor-toolbar" style="margin-top: 0.75rem; ${reference ? '' : 'display:none;'}">
          <div class="zone-toolbar-group">
            <span class="zone-toolbar-label">View</span>
            <button type="button" class="btn btn-ghost btn-sm" id="zone-zoom-out" title="Zoom out">−</button>
            <span class="zone-zoom-value" id="zone-zoom-value">100%</span>
            <button type="button" class="btn btn-ghost btn-sm" id="zone-zoom-in" title="Zoom in">+</button>
            <button type="button" class="btn btn-ghost btn-sm" id="zone-zoom-reset" title="Reset zoom and pan">Fit</button>
          </div>
          <div class="zone-toolbar-group">
            <span class="zone-toolbar-label">Rotation</span>
            <button type="button" class="btn btn-ghost btn-sm" id="zone-rotate-ccw" title="Rotate 90° counter-clockwise">↺ 90°</button>
            <button type="button" class="btn btn-ghost btn-sm" id="zone-rotate-cw" title="Rotate 90° clockwise">↻ 90°</button>
            <span class="zone-rotation-value" id="zone-rotation-value">${orientationDeg}°</span>
          </div>
          <div class="zone-toolbar-group zone-toolbar-group-end">
            <button type="button" class="btn btn-ghost btn-sm" id="zone-clear-all" title="Remove all zones">Clear zones</button>
          </div>
        </div>
        <div class="zone-canvas-wrap" id="canvas-wrap" style="margin-top: 0.75rem; ${reference ? '' : 'display:none;'}">
          <canvas id="zone-canvas"></canvas>
        </div>
        <p class="zone-editor-hint" style="margin-top: 0.75rem; font-size: 0.875rem; color: var(--color-text-muted); ${reference ? '' : 'display:none;'}" id="zone-editor-hint">
          Click and drag to draw a zone. Scroll to zoom, hold <kbd>Space</kbd> and drag to pan.
          ${isVideoMode()
    ? 'The still is taken at 0.5s into the clip. Saved zones use the same coordinates for <strong>all videos</strong>.'
    : 'Saved zones use the same coordinates for <strong>all photos</strong>.'}
        </p>
      </div>

      <div class="card">
        <h3>${isVideoMode() ? 'Video Zones' : 'Photo Zones'}</h3>
        <p style="margin-top: 0.35rem; font-size: 0.875rem; color: var(--color-text-muted);">
          These zones apply only to ${mediaNoun} when processing and in the gallery overlay — not to ${isVideoMode() ? 'photos' : 'videos'}.
        </p>
        <ul class="zone-list" id="zone-list" style="margin-top: 1rem;"></ul>
        <button class="btn btn-primary" id="save-zones-btn" style="margin-top: 1.5rem;">Save ${isVideoMode() ? 'Video' : 'Photo'} Zones</button>
      </div>
    </div>`;

  syncPanelHeader();
  renderZoneList();
  bindEvents();

  if (reference) {
    loadCanvasMedia(reference);
  }
}

function updateRotationLabel() {
  const label = document.getElementById('zone-rotation-value');
  if (label) label.textContent = `${orientationDeg}°`;
}

function updateZoomLabel() {
  const label = document.getElementById('zone-zoom-value');
  if (label) label.textContent = `${Math.round(viewZoom * 100)}%`;
}

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function applyViewTransform() {
  if (!baseImageRect.w) return;

  const cx = baseImageRect.x + baseImageRect.w / 2;
  const cy = baseImageRect.y + baseImageRect.h / 2;

  imageRect = {
    x: cx - (baseImageRect.w * viewZoom) / 2 + viewPanX,
    y: cy - (baseImageRect.h * viewZoom) / 2 + viewPanY,
    w: baseImageRect.w * viewZoom,
    h: baseImageRect.h * viewZoom,
  };
}

function resetView() {
  viewZoom = 1;
  viewPanX = 0;
  viewPanY = 0;
  updateZoomLabel();
  if (baseImageRect.w) applyViewTransform();
  if (ctx && img?.complete && img.naturalWidth) redrawCanvas();
}

function setZoom(nextZoom) {
  viewZoom = clampZoom(nextZoom);
  updateZoomLabel();
  applyViewTransform();
  if (ctx && img) redrawCanvas();
}

function adjustZoom(delta) {
  setZoom(viewZoom + delta);
}

function rotateImage(delta) {
  orientationDeg = normalizeOrientation(orientationDeg + delta);
  setStoredOrientation(orientationDeg);
  updateRotationLabel();
  if (img) {
    layoutCanvas();
    redrawCanvas();
  }
}

function renderZoneList() {
  const list = document.getElementById('zone-list');
  if (!list) return;

  const zones = getActiveZones();
  if (!zones.length) {
    list.innerHTML = `<li style="color: var(--color-text-muted); font-size: 0.875rem;">No zones yet — draw one on the reference ${isVideoMode() ? 'video' : 'image'}.</li>`;
    return;
  }

  list.innerHTML = zones.map((zone, i) => `
    <li class="zone-list-item">
      <input type="text" value="${zone.name}" data-zone-idx="${i}" aria-label="Zone name">
      <button class="btn btn-danger btn-sm" data-delete-zone="${i}">✕</button>
    </li>
  `).join('');

  list.querySelectorAll('[data-zone-idx]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.zoneIdx, 10);
      const next = getActiveZones();
      next[idx].name = e.target.value;
      setActiveZones(next);
    });
  });

  list.querySelectorAll('[data-delete-zone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = getActiveZones();
      next.splice(parseInt(btn.dataset.deleteZone, 10), 1);
      setActiveZones(next);
      renderZoneList();
      redrawCanvas();
    });
  });
}

function layoutCanvas() {
  const maxW = CANVAS_MAX_WIDTH;
  const maxH = maxW / LANDSCAPE_ASPECT;
  canvas.width = maxW;
  canvas.height = maxH;

  const { width: effW, height: effH } = getEffectiveDimensions(
    img.width,
    img.height,
    orientationDeg,
  );

  const imgAspect = effW / effH;
  let drawW;
  let drawH;

  if (imgAspect > LANDSCAPE_ASPECT) {
    drawW = maxW;
    drawH = maxW / imgAspect;
  } else {
    drawH = maxH;
    drawW = maxH * imgAspect;
  }

  baseImageRect = {
    x: (maxW - drawW) / 2,
    y: (maxH - drawH) / 2,
    w: drawW,
    h: drawH,
  };
  applyViewTransform();
}

function drawPhoto() {
  if (!img?.complete || !img.naturalWidth) return;

  const orient = resolveOrientation(img.width, img.height, orientationDeg);
  const drawW = orient === 90 || orient === 270 ? imageRect.h : imageRect.w;
  const drawH = orient === 90 || orient === 270 ? imageRect.w : imageRect.h;
  if (!drawW || !drawH) return;

  ctx.save();
  ctx.translate(imageRect.x + imageRect.w / 2, imageRect.y + imageRect.h / 2);
  ctx.rotate((orient * Math.PI) / 180);
  ctx.drawImage(
    img,
    -drawW / 2,
    -drawH / 2,
    drawW,
    drawH,
  );
  ctx.restore();
}

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function zoneToCanvas(zone) {
  return {
    x: imageRect.x + zone.x * imageRect.w,
    y: imageRect.y + zone.y * imageRect.h,
    w: zone.width * imageRect.w,
    h: zone.height * imageRect.h,
  };
}

function mediaFrameSrc(filename) {
  if (isVideoMode()) {
    return `/api/video-frame?file=${encodeURIComponent(filename)}&t=${Date.now()}`;
  }
  return `/api/file/${String(filename).split('/').map(encodeURIComponent).join('/')}`;
}

function loadCanvasMedia(filename) {
  canvas = document.getElementById('zone-canvas');
  if (!canvas) return;

  viewZoom = 1;
  viewPanX = 0;
  viewPanY = 0;
  updateZoomLabel();
  baseImageRect = { x: 0, y: 0, w: 0, h: 0 };
  imageRect = { x: 0, y: 0, w: 0, h: 0 };

  ctx = canvas.getContext('2d');
  img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const stored = getStoredOrientation();
    orientationDeg = stored != null
      ? normalizeOrientation(stored)
      : getDefaultOrientation(img.width, img.height);
    updateRotationLabel();
    layoutCanvas();
    redrawCanvas();
  };
  img.onerror = () => {
    showToast(`Failed to load ${isVideoMode() ? 'video frame' : 'image'}: ${filename}`, 'error');
  };
  img.src = mediaFrameSrc(filename);

  canvas.onmousedown = onMouseDown;
  canvas.onmousemove = onMouseMove;
  canvas.onmouseup = onMouseUp;
  canvas.onmouseleave = onMouseLeave;
  canvas.onwheel = onWheel;
  canvas.oncontextmenu = (e) => e.preventDefault();
}

function onWheel(e) {
  e.preventDefault();
  adjustZoom(e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
}

function onMouseLeave(e) {
  if (panning) {
    panning = false;
    canvas.style.cursor = spaceHeld ? 'grab' : 'crosshair';
  }
  onMouseUp(e);
}

function setCanvasCursor() {
  if (!canvas) return;
  canvas.style.cursor = panning ? 'grabbing' : (spaceHeld ? 'grab' : 'crosshair');
}

function redrawCanvas() {
  if (!ctx || !img?.complete || !img.naturalWidth) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawPhoto();

  getActiveZones().forEach((zone) => {
    const { x, y, w, h } = zoneToCanvas(zone);

    ctx.strokeStyle = '#6b5ce7';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(107, 92, 231, 0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#1e293b';
    ctx.font = '12px system-ui';
    ctx.fillText(zone.name, x + 4, y + 14);
  });

  if (currentRect) {
    ctx.strokeStyle = '#e85d8a';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(currentRect.x, currentRect.y, currentRect.w, currentRect.h);
    ctx.setLineDash([]);
  }
}

function onMouseDown(e) {
  if (spaceHeld || e.button === 1) {
    e.preventDefault();
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = viewPanX;
    panOriginY = viewPanY;
    setCanvasCursor();
    return;
  }

  if (e.button !== 0) return;

  const { x, y } = getCanvasCoords(e);
  startX = x;
  startY = y;
  drawing = true;
  currentRect = { x: startX, y: startY, w: 0, h: 0 };
}

function onMouseMove(e) {
  if (panning) {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    viewPanX = panOriginX + (e.clientX - panStartX) * scale;
    viewPanY = panOriginY + (e.clientY - panStartY) * scale;
    applyViewTransform();
    redrawCanvas();
    return;
  }

  if (!drawing) return;
  const { x, y } = getCanvasCoords(e);
  currentRect.w = x - startX;
  currentRect.h = y - startY;
  redrawCanvas();
}

function onMouseUp(e) {
  if (panning) {
    panning = false;
    setCanvasCursor();
    return;
  }

  if (!drawing || !currentRect) return;
  drawing = false;

  let { x, y, w, h } = currentRect;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }

  if (w < 10 || h < 10) {
    currentRect = null;
    redrawCanvas();
    return;
  }

  const name = prompt('Name this zone (e.g. "Salad bowl" or "Main plate"):');
  if (!name) {
    currentRect = null;
    redrawCanvas();
    return;
  }

  const zones = getActiveZones().slice();
  zones.push({
    name,
    x: (x - imageRect.x) / imageRect.w,
    y: (y - imageRect.y) / imageRect.h,
    width: w / imageRect.w,
    height: h / imageRect.h,
  });
  setActiveZones(zones);

  currentRect = null;
  renderZoneList();
  redrawCanvas();
}

function switchMode(nextMode) {
  if (nextMode === editorMode) return;
  setStoredOrientation(orientationDeg);
  editorMode = nextMode;
  const stored = getStoredOrientation();
  orientationDeg = stored != null ? normalizeOrientation(stored) : 0;
  render();
}

function bindEvents() {
  document.querySelectorAll('#zone-modality-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchMode(btn.dataset.mode === MODE_VIDEO ? MODE_VIDEO : MODE_PHOTO);
    });
  });

  document.getElementById('ref-media-select')?.addEventListener('change', (e) => {
    setReference(e.target.value || null);
    setStoredOrientation(null);
    orientationDeg = 0;
    const wrap = document.getElementById('canvas-wrap');
    const toolbar = document.getElementById('zone-editor-toolbar');
    const hint = document.getElementById('zone-editor-hint');
    const reference = getReference();
    if (reference) {
      wrap.style.display = '';
      toolbar.style.display = '';
      if (hint) hint.style.display = '';
      loadCanvasMedia(reference);
    } else {
      wrap.style.display = 'none';
      toolbar.style.display = 'none';
      if (hint) hint.style.display = 'none';
    }
  });

  document.getElementById('zone-zoom-out')?.addEventListener('click', () => adjustZoom(-ZOOM_STEP));
  document.getElementById('zone-zoom-in')?.addEventListener('click', () => adjustZoom(ZOOM_STEP));
  document.getElementById('zone-zoom-reset')?.addEventListener('click', resetView);
  document.getElementById('zone-rotate-ccw')?.addEventListener('click', () => rotateImage(-90));
  document.getElementById('zone-rotate-cw')?.addEventListener('click', () => rotateImage(90));
  document.getElementById('zone-clear-all')?.addEventListener('click', clearAllZones);
  document.getElementById('save-zones-btn')?.addEventListener('click', saveZones);

  if (!editorEventsBound) {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    editorEventsBound = true;
  }
}

function onKeyDown(e) {
  if (e.code !== 'Space' || e.repeat) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  spaceHeld = true;
  setCanvasCursor();
}

function onKeyUp(e) {
  if (e.code !== 'Space') return;
  spaceHeld = false;
  if (panning) {
    panning = false;
  }
  setCanvasCursor();
}

function clearAllZones() {
  if (!getActiveZones().length) return;
  if (!window.confirm('Remove all zones? This cannot be undone until you save.')) return;
  setActiveZones([]);
  renderZoneList();
  redrawCanvas();
}

async function saveZones() {
  try {
    setStoredOrientation(orientationDeg);
    const payload = {
      zones: settings.zones || [],
      referenceImage: settings.referenceImage || null,
      referenceOrientation: settings.referenceOrientation,
      videoZones: settings.videoZones || [],
      referenceVideo: settings.referenceVideo || null,
      referenceVideoOrientation: settings.referenceVideoOrientation,
      ai: {
        provider: settings.ai?.provider || 'google',
        model: settings.ai?.model || 'gemini-2.5-flash',
      },
    };

    settings = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const stored = getStoredOrientation();
    orientationDeg = stored != null ? normalizeOrientation(stored) : 0;

    showToast(`${isVideoMode() ? 'Video' : 'Photo'} zones saved successfully`, 'success');
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    [settings, files] = await Promise.all([
      apiFetch('/api/settings'),
      apiFetch('/api/files'),
    ]);
    if (!Array.isArray(settings.zones)) settings.zones = [];
    if (!Array.isArray(settings.videoZones)) settings.videoZones = [];

    const imageFiles = files.filter((f) => f.type === 'image');
    const videoFiles = files.filter((f) => f.type === 'video');
    if (settings.referenceImage) {
      settings.referenceImage = resolveReferenceMedia(settings.referenceImage, imageFiles);
    }
    if (settings.referenceVideo) {
      settings.referenceVideo = resolveReferenceMedia(settings.referenceVideo, videoFiles);
    }

    const stored = getStoredOrientation();
    orientationDeg = stored != null ? normalizeOrientation(stored) : 0;
    render();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <h3>Failed to load zones</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}
