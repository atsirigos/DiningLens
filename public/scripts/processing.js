import { apiFetch, formatBytes, formatDate, showToast } from './utils.js';
import { renderMealSummary, PROCESSING_ERROR_MSG } from './mealResults.js';

let files = [];
let results = {};
let processing = new Set();

const container = () => document.getElementById('processing-content');

function getUserContext() {
  return document.getElementById('meal-context')?.value.trim() || '';
}

function getStatus(filename) {
  if (processing.has(filename)) return 'processing';
  if (results[filename]) return 'done';
  return 'unprocessed';
}

function statusBadge(status) {
  const map = {
    unprocessed: '<span class="badge badge-muted">Unprocessed</span>',
    processing: '<span class="badge badge-warning">Processing</span>',
    done: '<span class="badge badge-success">Done</span>',
    error: '<span class="badge badge-danger">Error</span>',
  };
  return map[status] || map.unprocessed;
}

function render() {
  const imageFiles = files.filter((f) => f.type === 'image');

  if (imageFiles.length === 0) {
    container().innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚡</div>
        <h3>No images to process</h3>
        <p>Add meal photos to the data/ folder first.</p>
      </div>`;
    return;
  }

  const doneCount = imageFiles.filter((f) => results[f.name]).length;

  container().innerHTML = `
    <div class="card" style="padding: 1rem;">
      <div class="form-group" style="margin-bottom: 0;">
        <label for="meal-context">Meal context (optional)</label>
        <input
          type="text"
          id="meal-context"
          placeholder="e.g. half portion, restaurant meal, dressing on the side"
        >
      </div>
    </div>
    <div class="processing-actions">
      <button class="btn btn-primary" id="process-all-btn" ${processing.size > 0 ? 'disabled' : ''}>
        Process All (${imageFiles.length - doneCount} remaining)
      </button>
      <div id="batch-progress" class="hidden" style="flex: 1; max-width: 300px;">
        <div class="progress-bar"><div class="progress-bar-fill" id="progress-fill" style="width: 0%"></div></div>
        <p style="font-size: 0.75rem; margin-top: 0.25rem;" id="progress-text">0 / 0</p>
      </div>
    </div>
    <div class="processing-list" id="processing-list">
      ${imageFiles.map((file) => {
        const status = getStatus(file.name);
        return `
          <div class="card processing-row" data-file="${file.name}">
            <div class="processing-row-info">
              <div class="processing-row-name">${file.name}</div>
              <div class="processing-row-meta">${formatBytes(file.size)} · ${formatDate(file.modified)}</div>
            </div>
            <span class="status-badge">${statusBadge(status)}</span>
            <button class="btn btn-primary btn-sm process-btn" data-file="${file.name}" ${status === 'processing' ? 'disabled' : ''}>
              ${status === 'done' ? 'Re-process' : 'Process'}
            </button>
            ${status === 'done' ? `<button class="btn btn-danger btn-sm clear-btn" data-file="${file.name}">Clear</button>` : ''}
          </div>`;
      }).join('')}
    </div>
    <div id="processing-summary"></div>`;

  bindEvents();
}

function bindEvents() {
  document.getElementById('process-all-btn')?.addEventListener('click', processAll);

  document.querySelectorAll('.process-btn').forEach((btn) => {
    btn.addEventListener('click', () => processFile(btn.dataset.file));
  });

  document.querySelectorAll('.clear-btn').forEach((btn) => {
    btn.addEventListener('click', () => clearCache(btn.dataset.file));
  });
}

function updateRowStatus(filename, status) {
  const row = document.querySelector(`.processing-row[data-file="${CSS.escape(filename)}"]`);
  if (!row) return;
  row.querySelector('.status-badge').innerHTML = statusBadge(status);
  const btn = row.querySelector('.process-btn');
  if (btn) {
    btn.disabled = status === 'processing';
    btn.textContent = status === 'done' ? 'Re-process' : 'Process';
  }
}

async function processFile(filename) {
  if (processing.has(filename)) return;

  if (results[filename]) {
    await clearCache(filename, false);
  }

  processing.add(filename);
  updateRowStatus(filename, 'processing');

  const userContext = getUserContext();

  try {
    const data = await apiFetch('/api/process', {
      method: 'POST',
      body: JSON.stringify({ filename, userContext: userContext || undefined }),
    });
    results[filename] = data.result;
    showToast(`${filename} processed successfully`, 'success');
    showSummary(data.result);
  } catch (err) {
    updateRowStatus(filename, 'error');
    showToast(PROCESSING_ERROR_MSG, 'error');
  } finally {
    processing.delete(filename);
    updateRowStatus(filename, getStatus(filename));
    render();
    const ctx = document.getElementById('meal-context');
    if (ctx && userContext) ctx.value = userContext;
  }
}

async function clearCache(filename, reRender = true) {
  try {
    await apiFetch(`/api/process/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    delete results[filename];
    showToast(`Cache cleared for ${filename}`, 'info');
    if (reRender) render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function processAll() {
  const imageFiles = files.filter((f) => f.type === 'image' && !results[f.name]);
  if (imageFiles.length === 0) {
    showToast('All images already processed', 'info');
    return;
  }

  const userContext = getUserContext();
  const progressWrap = document.getElementById('batch-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  progressWrap.classList.remove('hidden');
  document.getElementById('process-all-btn').disabled = true;

  let completed = 0;
  const total = imageFiles.length;
  let lastResult = null;

  for (const file of imageFiles) {
    processing.add(file.name);
    updateRowStatus(file.name, 'processing');

    try {
      const data = await apiFetch('/api/process', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, userContext: userContext || undefined }),
      });
      results[file.name] = data.result;
      lastResult = data.result;
    } catch (err) {
      updateRowStatus(file.name, 'error');
      showToast(PROCESSING_ERROR_MSG, 'error');
    } finally {
      processing.delete(file.name);
      completed++;
      progressFill.style.width = `${(completed / total) * 100}%`;
      progressText.textContent = `${completed} / ${total}`;
    }
  }

  showToast(`Batch complete: ${completed}/${total} processed`, 'success');
  render();
  if (lastResult) showSummary(lastResult);
  const ctx = document.getElementById('meal-context');
  if (ctx && userContext) ctx.value = userContext;
}

function showSummary(result) {
  const el = document.getElementById('processing-summary');
  if (!el || !result) return;

  el.innerHTML = `
    <div class="card processing-summary glass">
      <p style="font-size: 0.875rem; color: var(--color-text-muted); margin-bottom: 1rem;">
        Latest: ${result.filename || 'Unknown'} · ${result.processedAt ? formatDate(result.processedAt) : ''}
      </p>
      ${renderMealSummary(result)}
    </div>`;
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    [files, results] = await Promise.all([
      apiFetch('/api/files'),
      apiFetch('/api/results'),
    ]);
    render();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <h3>Failed to load processing data</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}
