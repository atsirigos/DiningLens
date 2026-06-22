import { apiFetch, showToast } from './utils.js';

let settings = {};
let files = [];
let canvas, ctx, img;
let drawing = false;
let startX, startY;
let currentRect = null;

const container = () => document.getElementById('zones-content');

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
              <option value="${f.name}" ${settings.referenceImage === f.name ? 'selected' : ''}>${f.name}</option>
            `).join('')}
          </select>
        </div>
        <div class="zone-canvas-wrap" id="canvas-wrap" style="margin-top: 1rem; ${settings.referenceImage ? '' : 'display:none;'}">
          <canvas id="zone-canvas"></canvas>
        </div>
        <p style="margin-top: 0.75rem; font-size: 0.875rem; color: var(--color-text-muted);">
          Click and drag on the image to draw a zone. You'll be prompted to name it.
        </p>
      </div>

      <div class="card">
        <h3>Zones</h3>
        <p style="margin-top: 0.35rem; font-size: 0.875rem; color: var(--color-text-muted);">
          Zones you've drawn on the reference image. Rename or remove them here.
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

function loadCanvasImage(filename) {
  canvas = document.getElementById('zone-canvas');
  if (!canvas) return;

  ctx = canvas.getContext('2d');
  img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const maxW = 700;
    const scale = Math.min(1, maxW / img.width);
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    redrawCanvas();
  };
  img.src = `/api/file/${encodeURIComponent(filename)}`;

  canvas.onmousedown = onMouseDown;
  canvas.onmousemove = onMouseMove;
  canvas.onmouseup = onMouseUp;
  canvas.onmouseleave = onMouseUp;
}

function redrawCanvas() {
  if (!ctx || !img) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  (settings.zones || []).forEach((zone) => {
    const x = zone.x * canvas.width;
    const y = zone.y * canvas.height;
    const w = zone.width * canvas.width;
    const h = zone.height * canvas.height;

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
  const rect = canvas.getBoundingClientRect();
  startX = e.clientX - rect.left;
  startY = e.clientY - rect.top;
  drawing = true;
  currentRect = { x: startX, y: startY, w: 0, h: 0 };
}

function onMouseMove(e) {
  if (!drawing) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  currentRect.w = x - startX;
  currentRect.h = y - startY;
  redrawCanvas();
}

function onMouseUp() {
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
    x: x / canvas.width,
    y: y / canvas.height,
    width: w / canvas.width,
    height: h / canvas.height,
  });

  currentRect = null;
  renderZoneList();
  redrawCanvas();
}

function bindEvents() {
  document.getElementById('ref-image-select')?.addEventListener('change', (e) => {
    settings.referenceImage = e.target.value || null;
    const wrap = document.getElementById('canvas-wrap');
    if (settings.referenceImage) {
      wrap.style.display = '';
      loadCanvasImage(settings.referenceImage);
    } else {
      wrap.style.display = 'none';
    }
  });

  document.getElementById('save-zones-btn')?.addEventListener('click', saveZones);
}

async function saveZones() {
  try {
    const payload = {
      zones: settings.zones,
      referenceImage: settings.referenceImage,
      ai: {
        provider: settings.ai?.provider || 'google',
        model: settings.ai?.model || 'gemini-2.5-flash',
      },
    };

    settings = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

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
