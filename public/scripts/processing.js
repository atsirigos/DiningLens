import { apiFetch, formatBytes, formatDate, showToast } from './utils.js';
import { renderMealSummary, PROCESSING_ERROR_MSG } from './mealResults.js';
import { confirmZoneProcessing } from './zonePreviewModal.js';

const PROCESSING_FOCUS_KEY = 'processingFocus';

let files = [];
let results = {};
let appSettings = { zones: [], videoZones: [] };
let processing = new Set();

const container = () => document.getElementById('processing-content');

function getFileKey(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  return file.path || file.name || '';
}

function findFileRecord(fileKey) {
  return files.find((file) => getFileKey(file) === fileKey)
    || files.find((file) => file.name === fileKey);
}

function getResultForFileKey(fileKey) {
  const file = findFileRecord(fileKey);
  const path = file ? getFileKey(file) : fileKey;
  return results[path] || results[path.split('/').pop()] || null;
}

function getUserContext() {
  return document.getElementById('meal-context')?.value.trim() || '';
}

function getStatus(fileKey) {
  if (processing.has(fileKey)) return 'processing';
  if (getResultForFileKey(fileKey)) return 'done';
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

function zonesForFile(file) {
  if (file?.type === 'video') {
    return {
      zones: appSettings.videoZones || [],
      orientationDeg: appSettings.referenceVideoOrientation,
      mediaType: 'video',
    };
  }
  return {
    zones: appSettings.zones || [],
    orientationDeg: appSettings.referenceOrientation,
    mediaType: 'image',
  };
}

function render() {
  const mediaFiles = files.filter((f) => f.type === 'image' || f.type === 'video');

  if (mediaFiles.length === 0) {
    container().innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚡</div>
        <h3>No media to process</h3>
        <p>Add meal photos or videos to the data/ folder first.</p>
      </div>`;
    return;
  }

  const doneCount = mediaFiles.filter((f) => getResultForFileKey(getFileKey(f))).length;
  const photoZoneCount = appSettings.zones?.length || 0;
  const videoZoneCount = appSettings.videoZones?.length || 0;

  container().innerHTML = `
    ${photoZoneCount || videoZoneCount ? `
      <div class="card zone-config-banner" style="padding: 1rem; margin-bottom: 0;">
        <p style="font-size: 0.875rem; margin: 0;">
          ${photoZoneCount ? `<strong>${photoZoneCount} photo zone${photoZoneCount === 1 ? '' : 's'}</strong>` : ''}
          ${photoZoneCount && videoZoneCount ? ' · ' : ''}
          ${videoZoneCount ? `<strong>${videoZoneCount} video zone${videoZoneCount === 1 ? '' : 's'}</strong>` : ''}
          configured.
          Each media file is cropped with its modality’s zones and analyzed with a <strong>separate API call</strong> per zone.
          Videos are analyzed from a still frame at 0.5s.
        </p>
        ${photoZoneCount ? `
          <p style="font-size: 0.8rem; color: var(--color-text-muted); margin: 0.35rem 0 0;">
            Photos: ${appSettings.zones.map((z) => z.name).join(' · ')}
          </p>` : ''}
        ${videoZoneCount ? `
          <p style="font-size: 0.8rem; color: var(--color-text-muted); margin: 0.35rem 0 0;">
            Videos: ${appSettings.videoZones.map((z) => z.name).join(' · ')}
          </p>` : ''}
      </div>
    ` : ''}
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
        Process All (${mediaFiles.length - doneCount} remaining)
      </button>
      <div id="batch-progress" class="hidden" style="flex: 1; max-width: 300px;">
        <div class="progress-bar"><div class="progress-bar-fill" id="progress-fill" style="width: 0%"></div></div>
        <p style="font-size: 0.75rem; margin-top: 0.25rem;" id="progress-text">0 / 0</p>
      </div>
    </div>
    <div class="processing-list" id="processing-list">
      ${mediaFiles.map((file) => {
        const fileKey = getFileKey(file);
        const status = getStatus(fileKey);
        const displayName = file.path?.includes('/') ? file.path : file.name;
        const typeBadge = file.type === 'video'
          ? '<span class="badge badge-muted">Video</span>'
          : '';
        return `
          <div class="card processing-row" data-file="${fileKey.replace(/"/g, '&quot;')}">
            <div class="processing-row-info">
              <div class="processing-row-name">${displayName} ${typeBadge}</div>
              <div class="processing-row-meta">${formatBytes(file.size)} · ${formatDate(file.modified)}</div>
            </div>
            <span class="status-badge">${statusBadge(status)}</span>
            <button class="btn btn-primary btn-sm process-btn" data-file="${fileKey.replace(/"/g, '&quot;')}" ${status === 'processing' ? 'disabled' : ''}>
              ${status === 'done' ? 'Re-process' : 'Process'}
            </button>
            ${status === 'done' ? `<button class="btn btn-ghost btn-sm view-results-btn" data-file="${fileKey.replace(/"/g, '&quot;')}">Results</button>` : ''}
            ${status === 'done' ? `<button class="btn btn-danger btn-sm clear-btn" data-file="${fileKey.replace(/"/g, '&quot;')}">Clear</button>` : ''}
          </div>`;
      }).join('')}
    </div>
    <div id="processing-summary"></div>`;

  bindEvents();
  consumeNavigationFocus();
}

function bindEvents() {
  document.getElementById('process-all-btn')?.addEventListener('click', processAll);

  document.querySelectorAll('.process-btn').forEach((btn) => {
    btn.addEventListener('click', () => processFile(btn.dataset.file));
  });

  document.querySelectorAll('.view-results-btn').forEach((btn) => {
    btn.addEventListener('click', () => focusFile(btn.dataset.file, { scroll: true, showResult: true }));
  });

  document.querySelectorAll('.clear-btn').forEach((btn) => {
    btn.addEventListener('click', () => clearCache(btn.dataset.file));
  });
}

function updateRowStatus(fileKey, status) {
  const row = document.querySelector(`.processing-row[data-file="${CSS.escape(fileKey)}"]`);
  if (!row) return;
  row.querySelector('.status-badge').innerHTML = statusBadge(status);
  const btn = row.querySelector('.process-btn');
  if (btn) {
    btn.disabled = status === 'processing';
    btn.textContent = status === 'done' ? 'Re-process' : 'Process';
  }
}

function focusFile(fileKey, { scroll = true, showResult = true } = {}) {
  const row = document.querySelector(`.processing-row[data-file="${CSS.escape(fileKey)}"]`);
  if (!row) return false;

  if (scroll) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('processing-row-highlight');
    setTimeout(() => row.classList.remove('processing-row-highlight'), 2200);
  }

  if (showResult) {
    const result = getResultForFileKey(fileKey);
    if (result) showSummary(result);
  }

  return true;
}

function consumeNavigationFocus() {
  try {
    const raw = sessionStorage.getItem(PROCESSING_FOCUS_KEY);
    if (!raw) return;

    sessionStorage.removeItem(PROCESSING_FOCUS_KEY);
    const payload = JSON.parse(raw);
    const fileKey = payload.path || payload.name;
    if (!fileKey) return;

    if (!focusFile(fileKey, { scroll: true, showResult: true })) {
      showToast('Could not find that frame in the processing list', 'info');
    }
  } catch {
    sessionStorage.removeItem(PROCESSING_FOCUS_KEY);
  }
}

async function processFile(fileKey) {
  if (processing.has(fileKey)) return;

  const file = findFileRecord(fileKey);
  const filename = getFileKey(file) || fileKey;
  const { zones, orientationDeg, mediaType } = zonesForFile(file);
  const pick = await confirmZoneProcessing({
    filename: file?.name || filename.split('/').pop(),
    filePath: filename,
    zones,
    orientationDeg,
    mediaType,
  });
  if (!pick?.confirmed) return;

  if (getResultForFileKey(fileKey)) {
    await clearCache(fileKey, false);
  }

  processing.add(fileKey);
  updateRowStatus(fileKey, 'processing');

  const userContext = getUserContext();

  try {
    const body = {
      filename,
      userContext: userContext || undefined,
    };
    if (mediaType === 'video' && Number.isFinite(Number(pick.frameTimeSec))) {
      body.frameTimeSec = Number(pick.frameTimeSec);
    }
    const data = await apiFetch('/api/process', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    results[filename] = data.result;
    showToast(
      mediaType === 'video'
        ? `${file?.name || filename} processed (frame ${Number(pick.frameTimeSec || 0).toFixed(1)}s)`
        : `${file?.name || filename} processed successfully`,
      'success',
    );
    showSummary(data.result);
  } catch (err) {
    updateRowStatus(fileKey, 'error');
    showToast(PROCESSING_ERROR_MSG, 'error');
  } finally {
    processing.delete(fileKey);
    updateRowStatus(fileKey, getStatus(fileKey));
    render();
    const ctx = document.getElementById('meal-context');
    if (ctx && userContext) ctx.value = userContext;
  }
}

async function clearCache(fileKey, reRender = true) {
  const file = findFileRecord(fileKey);
  const filename = getFileKey(file) || fileKey;

  try {
    await apiFetch(`/api/process/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    delete results[filename];
    delete results[filename.split('/').pop()];
    showToast(`Cache cleared for ${file?.name || filename}`, 'info');
    if (reRender) render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function processAll() {
  const mediaFiles = files.filter(
    (f) => (f.type === 'image' || f.type === 'video') && !getResultForFileKey(getFileKey(f)),
  );
  if (mediaFiles.length === 0) {
    showToast('All media already processed', 'info');
    return;
  }

  const userContext = getUserContext();
  const progressWrap = document.getElementById('batch-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  progressWrap.classList.remove('hidden');
  document.getElementById('process-all-btn').disabled = true;

  let completed = 0;
  const total = mediaFiles.length;
  let lastResult = null;

  for (const file of mediaFiles) {
    const fileKey = getFileKey(file);
    const { zones, orientationDeg, mediaType } = zonesForFile(file);
    const pick = await confirmZoneProcessing({
      filename: file.name,
      filePath: fileKey,
      zones,
      orientationDeg,
      mediaType,
    });
    if (!pick?.confirmed) {
      showToast('Batch processing cancelled', 'info');
      break;
    }

    processing.add(fileKey);
    updateRowStatus(fileKey, 'processing');

    try {
      const body = {
        filename: fileKey,
        userContext: userContext || undefined,
      };
      if (mediaType === 'video' && Number.isFinite(Number(pick.frameTimeSec))) {
        body.frameTimeSec = Number(pick.frameTimeSec);
      }
      const data = await apiFetch('/api/process', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      results[fileKey] = data.result;
      lastResult = data.result;
    } catch (err) {
      updateRowStatus(fileKey, 'error');
      showToast(PROCESSING_ERROR_MSG, 'error');
    } finally {
      processing.delete(fileKey);
      completed++;
      progressFill.style.width = `${(completed / total) * 100}%`;
      progressText.textContent = `${completed} / ${total}`;
    }
  }

  if (completed > 0) {
    showToast(`Batch complete: ${completed}/${total} processed`, 'success');
  }
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

  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    [files, results, appSettings] = await Promise.all([
      apiFetch('/api/files'),
      apiFetch('/api/results'),
      apiFetch('/api/settings'),
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
