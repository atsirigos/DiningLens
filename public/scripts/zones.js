import { apiFetch, showToast } from './utils.js';
import {
  getEffectiveDimensions,
  resolveOrientation,
  getDefaultOrientation,
  normalizeOrientation,
} from './zoneGeometry.js';

let settings = {};
let files = [];
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

function resolveReferenceImage(savedRef, imageFiles) {
  if (!savedRef) return null;
  const exact = imageFiles.find((f) => fileRef(f) === savedRef);
  if (exact) return fileRef(exact);
  const byName = imageFiles.filter((f) => f.name === savedRef);
  if (byName.length === 1) return fileRef(byName[0]);
  return null;
}

function render() {
  container().innerHTML = `
    <div class="settings-grid">
      <div class="card">
        <h3>Zone Editor</h3>
        <div class="form-group" style="margin-top: 1rem;">
          <label for="ref-image-select">Reference Image</label>
          <select id="ref-image-select">
            <option value="">Select an image...</option>
            ${files.filter((f) => f.type === 'image').map((f) => `
              <option value="${fileRef(f)}" ${settings.referenceImage === fileRef(f) ? 'selected' : ''}>${fileLabel(f)}</option>
            `).join('')}
          </select>
        </div>
        <div class="zone-editor-toolbar" id="zone-editor-toolbar" style="margin-top: 0.75rem; ${settings.referenceImage ? '' : 'display:none;'}">
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
        <div class="zone-canvas-wrap" id="canvas-wrap" style="margin-top: 0.75rem; ${settings.referenceImage ? '' : 'display:none;'}">
          <canvas id="zone-canvas"></canvas>
        </div>
        <p class="zone-editor-hint" style="margin-top: 0.75rem; font-size: 0.875rem; color: var(--color-text-muted); ${settings.referenceImage ? '' : 'display:none;'}" id="zone-editor-hint">
          Click and drag to draw a zone. Scroll to zoom, hold <kbd>Space</kbd> and drag to pan.
          Saved zones use the same coordinates for <strong>all photos</strong>.
        </p>
      </div>

      <div class="card">
        <h3>Zones</h3>
        <p style="margin-top: 0.35rem; font-size: 0.875rem; color: var(--color-text-muted);">
          These zones apply to every image when processing and in the gallery overlay — not only the reference photo.
        </p>
        <ul class="zone-list" id="zone-list" style="margin-top: 1rem;"></ul>
        <button class="btn btn-primary" id="save-zones-btn" style="margin-top: 1.5rem;">Save Zones</button>
      </div>
    </div>`;

  renderZoneList();
  bindEvents();

  if (settings.referenceImage) {
    loadCanvasImage(settings.referenceImage);
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
  settings.referenceOrientation = orientationDeg;
  updateRotationLabel();
  if (img) {
    layoutCanvas();
    redrawCanvas();
  }
}

function renderZoneList() {
  const list = document.getElementById('zone-list');
  if (!list) return;

  if (!settings.zones?.length) {
    list.innerHTML = '<li style="color: var(--color-text-muted); font-size: 0.875rem;">No zones yet — draw one on the reference image.</li>';
    return;
  }

  list.innerHTML = settings.zones.map((zone, i) => `
    <li class="zone-list-item">
      <input type="text" value="${zone.name}" data-zone-idx="${i}" aria-label="Zone name">
      <button class="btn btn-danger btn-sm" data-delete-zone="${i}">✕</button>
    </li>
  `).join('');

  list.querySelectorAll('[data-zone-idx]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.zoneIdx, 10);
      settings.zones[idx].name = e.target.value;
    });
  });

  list.querySelectorAll('[data-delete-zone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.zones.splice(parseInt(btn.dataset.deleteZone, 10), 1);
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

function loadCanvasImage(filename) {
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
  const imgSrc = `/api/file/${encodeURIComponent(filename)}`;
  img.onload = () => {
    orientationDeg = settings.referenceOrientation != null
      ? normalizeOrientation(settings.referenceOrientation)
      : getDefaultOrientation(img.width, img.height);
    updateRotationLabel();
    layoutCanvas();
    redrawCanvas();
  };
  img.onerror = () => {
    showToast(`Failed to load image: ${filename}`, 'error');
  };
  img.src = imgSrc;

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

  (settings.zones || []).forEach((zone) => {
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

  if (!settings.zones) settings.zones = [];

  settings.zones.push({
    name,
    x: (x - imageRect.x) / imageRect.w,
    y: (y - imageRect.y) / imageRect.h,
    width: w / imageRect.w,
    height: h / imageRect.h,
  });

  currentRect = null;
  renderZoneList();
  redrawCanvas();
}

function bindEvents() {
  document.getElementById('ref-image-select')?.addEventListener('change', (e) => {
    settings.referenceImage = e.target.value || null;
    settings.referenceOrientation = null;
    const wrap = document.getElementById('canvas-wrap');
    const toolbar = document.getElementById('zone-editor-toolbar');
    const hint = document.getElementById('zone-editor-hint');
    if (settings.referenceImage) {
      wrap.style.display = '';
      toolbar.style.display = '';
      if (hint) hint.style.display = '';
      loadCanvasImage(settings.referenceImage);
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
  if (!settings.zones?.length) return;
  if (!window.confirm('Remove all zones? This cannot be undone until you save.')) return;
  settings.zones = [];
  renderZoneList();
  redrawCanvas();
}

async function saveZones() {
  try {
    const payload = {
      zones: settings.zones,
      referenceImage: settings.referenceImage,
      referenceOrientation: orientationDeg,
      ai: {
        provider: settings.ai?.provider || 'google',
        model: settings.ai?.model || 'gemini-2.5-flash',
      },
    };

    settings = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    orientationDeg = settings.referenceOrientation != null
      ? normalizeOrientation(settings.referenceOrientation)
      : 0;

    showToast('Zones saved successfully', 'success');
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
    const imageFiles = files.filter((f) => f.type === 'image');
    if (settings.referenceImage) {
      settings.referenceImage = resolveReferenceImage(settings.referenceImage, imageFiles);
    }
    orientationDeg = settings.referenceOrientation != null
      ? normalizeOrientation(settings.referenceOrientation)
      : 0;
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
