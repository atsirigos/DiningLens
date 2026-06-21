import { apiFetch, showToast } from './utils.js';

let settings = {};
let files = [];
let canvas, ctx, img;
let drawing = false;
let startX, startY;
let currentRect = null;

const container = () => document.getElementById('settings-content');

function renderModelOptions() {
  const provider = settings.ai?.provider || 'google';
  const models = settings.aiProviders?.[provider]?.models || [];
  const selected = settings.ai?.model || models[0]?.id || '';

  return models.map((m) => `
    <option value="${m.id}" ${selected === m.id ? 'selected' : ''}>${m.label}</option>
  `).join('');
}

function renderProviderOptions() {
  const providers = settings.aiProviders || { google: { label: 'Google' } };
  const selected = settings.ai?.provider || 'google';

  return Object.entries(providers).map(([id, p]) => `
    <option value="${id}" ${selected === id ? 'selected' : ''}>${p.label}</option>
  `).join('');
}

function renderAiCard() {
  const apiKeySet = settings.ai?.apiKeySet;

  return `
    <div class="card">
      <h3>AI Configuration</h3>
      <p style="margin-top: 0.35rem; font-size: 0.875rem; color: var(--color-text-muted);">
        Choose your AI provider and model for meal photo analysis.
      </p>
      <div class="form-group" style="margin-top: 1rem;">
        <label for="ai-provider">Provider</label>
        <select id="ai-provider">${renderProviderOptions()}</select>
      </div>
      <div class="form-group">
        <label for="ai-model">Model</label>
        <select id="ai-model">${renderModelOptions()}</select>
      </div>
      <div class="form-group">
        <label for="api-key">API Key</label>
        <div class="api-key-row">
          <input
            type="password"
            id="api-key"
            placeholder="${apiKeySet ? 'Key saved — enter new value to replace' : 'Enter your API key'}"
            autocomplete="off"
          >
          <button type="button" class="btn btn-ghost btn-sm" id="toggle-api-key" aria-label="Show API key">Show</button>
        </div>
        ${apiKeySet ? '<p class="api-key-hint"><span class="badge badge-success">Configured</span></p>' : ''}
      </div>
    </div>`;
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
        <ul class="zone-list" id="zone-list" style="margin-top: 1rem;"></ul>
      </div>

      <div style="display: flex; flex-direction: column; gap: 1.5rem;">
        ${renderAiCard()}

        <div class="card">
          <h3>Seat Layout</h3>
          <div class="seat-picker" id="seat-picker" style="margin-top: 1rem;">
            ${[2, 4, 6].map((n) => `
              <button class="btn btn-ghost ${settings.seatLayout === n ? 'active' : ''}" data-seats="${n}">${n}-seat</button>
            `).join('')}
          </div>
          <div class="form-row" style="margin-top: 0.75rem;">
            <label for="custom-seats">Custom:</label>
            <input type="number" id="custom-seats" min="1" max="20" value="${settings.seatLayout || 2}" style="width: 80px;">
          </div>
        </div>

        <div class="card">
          <h3>Common Foods</h3>
          <ul class="foods-list" id="foods-list" style="margin-top: 1rem;"></ul>
          <div class="form-row" style="margin-top: 0.75rem;">
            <input type="text" id="new-food" placeholder="Add a food label...">
            <button class="btn btn-ghost btn-sm" id="add-food-btn">Add</button>
          </div>
        </div>

        <button class="btn btn-primary" id="save-settings-btn">Save Settings</button>
      </div>
    </div>`;

  renderZoneList();
  renderFoodsList();
  bindEvents();

  if (settings.referenceImage) {
    loadCanvasImage(settings.referenceImage);
  }
}

function renderZoneList() {
  const list = document.getElementById('zone-list');
  if (!list) return;

  if (!settings.zones?.length) {
    list.innerHTML = '<li style="color: var(--color-text-muted); font-size: 0.875rem;">No zones defined yet.</li>';
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

function renderFoodsList() {
  const list = document.getElementById('foods-list');
  if (!list) return;

  list.innerHTML = (settings.commonFoods || []).map((food, i) => `
    <li class="foods-list-item">
      <input type="text" value="${food}" data-food-idx="${i}">
      <button class="btn btn-danger btn-sm" data-delete-food="${i}">✕</button>
    </li>
  `).join('');

  list.querySelectorAll('[data-food-idx]').forEach((input) => {
    input.addEventListener('change', (e) => {
      settings.commonFoods[parseInt(e.target.dataset.foodIdx, 10)] = e.target.value;
    });
  });

  list.querySelectorAll('[data-delete-food]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.commonFoods.splice(parseInt(btn.dataset.deleteFood, 10), 1);
      renderFoodsList();
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

    ctx.strokeStyle = '#7c6ff7';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(124, 111, 247, 0.15)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#e8e8f0';
    ctx.font = '12px system-ui';
    ctx.fillText(zone.name, x + 4, y + 14);
  });

  if (currentRect) {
    ctx.strokeStyle = '#f76f9b';
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

  const name = prompt('Name this zone (e.g. "Seat 1 Plate"):');
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
  document.getElementById('ai-provider')?.addEventListener('change', (e) => {
    if (!settings.ai) settings.ai = {};
    settings.ai.provider = e.target.value;

    const models = settings.aiProviders?.[settings.ai.provider]?.models || [];
    settings.ai.model = models[0]?.id || '';

    const modelSelect = document.getElementById('ai-model');
    if (modelSelect) {
      modelSelect.innerHTML = models.map((m) => `
        <option value="${m.id}" ${settings.ai.model === m.id ? 'selected' : ''}>${m.label}</option>
      `).join('');
    }
  });

  document.getElementById('ai-model')?.addEventListener('change', (e) => {
    if (!settings.ai) settings.ai = {};
    settings.ai.model = e.target.value;
  });

  document.getElementById('toggle-api-key')?.addEventListener('click', () => {
    const input = document.getElementById('api-key');
    const btn = document.getElementById('toggle-api-key');
    if (!input || !btn) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });

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

  document.querySelectorAll('#seat-picker button').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.seatLayout = parseInt(btn.dataset.seats, 10);
      document.querySelectorAll('#seat-picker button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('custom-seats').value = settings.seatLayout;
    });
  });

  document.getElementById('custom-seats')?.addEventListener('change', (e) => {
    settings.seatLayout = parseInt(e.target.value, 10) || 2;
    document.querySelectorAll('#seat-picker button').forEach((b) => {
      b.classList.toggle('active', parseInt(b.dataset.seats, 10) === settings.seatLayout);
    });
  });

  document.getElementById('add-food-btn')?.addEventListener('click', () => {
    const input = document.getElementById('new-food');
    const val = input.value.trim();
    if (!val) return;
    if (!settings.commonFoods) settings.commonFoods = [];
    settings.commonFoods.push(val);
    input.value = '';
    renderFoodsList();
  });

  document.getElementById('new-food')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('add-food-btn').click();
  });

  document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
}

async function saveSettings() {
  try {
    const payload = {
      zones: settings.zones,
      commonFoods: settings.commonFoods,
      seatLayout: settings.seatLayout,
      referenceImage: settings.referenceImage,
      ai: {
        provider: document.getElementById('ai-provider')?.value || settings.ai?.provider || 'google',
        model: document.getElementById('ai-model')?.value || settings.ai?.model || 'gemini-2.5-flash',
      },
    };

    const apiKey = document.getElementById('api-key')?.value.trim();
    if (apiKey) {
      payload.ai.apiKey = apiKey;
    }

    settings = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    document.getElementById('api-key').value = '';
    showToast('Settings saved successfully', 'success');
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
        <h3>Failed to load settings</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}
