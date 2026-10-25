import { apiFetch, formatBytes, formatDate, isFrameRecording, mealLabel, showToast } from './utils.js';
import { applySettingsFlags, isFrameRecordingsEnabled } from './featureFlags.js';
import { renderMealSummary, PROCESSING_ERROR_MSG } from './mealResults.js';
import { confirmZoneProcessing } from './zonePreviewModal.js';
import { groupFiles } from './gallery.js';

const PROCESSING_FOCUS_KEY = 'processingFocus';

let files = [];
let results = {};
let appSettings = { zones: [], videoZones: [] };
let processing = new Set();
const expanded = new Set();

const container = () => document.getElementById('processing-content');

function getFileKey(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  return file.path || file.name || '';
}

function groupedItems() {
  return groupFiles(files).filter((item) => {
    if (item.type !== 'recording' && item.type !== 'image' && item.type !== 'video') return false;
    if (!isFrameRecordingsEnabled() && isFrameRecording(item)) return false;
    return true;
  });
}

function findFileRecord(fileKey) {
  return files.find((file) => getFileKey(file) === fileKey)
    || files.find((file) => file.name === fileKey);
}

function getResultForFileKey(fileKey) {
  const file = findFileRecord(fileKey);
  const key = file ? getFileKey(file) : fileKey;
  return results[key] || results[String(key).split('/').pop()] || null;
}

function getUserContext() {
  return document.getElementById('meal-context')?.value.trim() || '';
}

function restoreUserContext(userContext) {
  const ctx = document.getElementById('meal-context');
  if (ctx && userContext) ctx.value = userContext;
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
  if (file?.type === 'video' || file?.mode === 'video') {
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function formatDurationMinutes(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return 'Under 1 min';
  return `${Math.round(n / 60)} min`;
}

function mealDurationSec(item) {
  const videos = item?.videos || [];
  if (!videos.length) return null;
  let total = 0;
  for (const video of videos) {
    const n = Number(video?.durationSec);
    if (!Number.isFinite(n) || n < 0) return null;
    total += n;
  }
  return total;
}

function isVideoMeal(item) {
  return item?.mode === 'video' || (!item?.frames?.length && item?.videos?.length);
}

function itemKey(item) {
  return item.path || item.name;
}

function itemLabel(item) {
  if (item.type === 'recording') return mealLabel(item);
  return item.path?.includes('/') ? item.path : item.name;
}

function formatClock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '';
  const total = Math.floor(n);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function framesForResult(result) {
  if (Array.isArray(result?.frames) && result.frames.length) return result.frames;
  if (result?.mediaType === 'video' && result.filename) {
    return [{ file: result.filename, timeSec: result.frameTimeSec }];
  }
  return [];
}

function zonesForResult(result, item) {
  if (result?.zones_applied?.length) return result.zones_applied;
  const video = result?.captureMode === 'video'
    || result?.mediaType === 'video'
    || item?.mode === 'video'
    || item?.type === 'video';
  const list = video ? appSettings.videoZones : appSettings.zones;
  return (list || []).map((zone) => zone.name).filter(Boolean);
}

function frameLabel(frame, index) {
  const name = String(frame.file || '').split('/').pop() || `Frame ${index + 1}`;
  const match = name.match(/video_(\d+)/i);
  const title = match ? `Clip ${Number(match[1])}` : name;
  const clock = formatClock(frame.timeSec);
  return clock ? `${title} · ${clock}` : title;
}

function frameCropUrl(frame, zone) {
  let url = `/api/zone-crop?file=${encodeURIComponent(frame.file)}&zone=${encodeURIComponent(zone)}`;
  if (Number.isFinite(Number(frame.timeSec)) && Number(frame.timeSec) >= 0) {
    url += `&timeSec=${encodeURIComponent(String(frame.timeSec))}`;
  }
  return url;
}

function renderFrameSets(result, item) {
  const frames = framesForResult(result);
  const zones = zonesForResult(result, item);
  if (!frames.length || !zones.length) return '';

  return `
    <div class="processing-frame-sets">
      <h4 class="meal-section-title">Frames used</h4>
      ${zones.map((zone) => `
        <section class="processing-zone-set">
          <p class="confidence-notes">${escapeHtml(zone)}</p>
          <div class="processing-frame-strip">
            ${frames.map((frame, index) => {
              const label = frameLabel(frame, index);
              return `
                <figure class="analysis-zone-crop processing-frame-thumb">
                  <img src="${frameCropUrl(frame, zone)}" alt="${escapeHtml(label)}" loading="lazy">
                  <figcaption title="${escapeHtml(label)}">${escapeHtml(label)}</figcaption>
                </figure>`;
            }).join('')}
          </div>
        </section>
      `).join('')}
    </div>`;
}

function renderFoodPreview(result) {
  const names = (result?.items || []).map((item) => String(item?.name || '').trim()).filter(Boolean);
  if (!names.length) return '';
  return `<p class="processing-food-summary">${escapeHtml(names.join(', '))}</p>`;
}

function renderProcessingCard(item) {
  const key = itemKey(item);
  const status = getStatus(key);
  const isMeal = item.type === 'recording';
  const label = itemLabel(item);
  const result = status === 'done' ? getResultForFileKey(key) : null;
  const open = Boolean(result) && expanded.has(key);

  return `
    <div class="card processing-card${open ? ' is-open' : ''}${result?.items?.length ? ' has-foods' : ''}" data-file="${escapeHtml(key)}">
      <div class="processing-row">
        <div class="processing-row-info">
          <div class="processing-row-name">${escapeHtml(label)} ${isMeal ? '<span class="badge badge-muted">Meal</span>' : ''}</div>
          <div class="processing-row-meta">${escapeHtml(itemMeta(item))}</div>
        </div>
        <span class="status-badge">${statusBadge(status)}</span>
        <button class="btn btn-primary btn-sm process-btn" data-kind="${isMeal ? 'meal' : 'file'}" data-file="${escapeHtml(key)}" ${status === 'processing' ? 'disabled' : ''}>
          ${status === 'done' ? 'Re-process' : 'Process'}
        </button>
        ${status === 'done' ? `<button class="btn btn-ghost btn-sm toggle-results-btn" data-file="${escapeHtml(key)}" aria-expanded="${open}">${open ? 'Hide' : 'Results'}</button>` : ''}
        ${status === 'done' ? `<button class="btn btn-danger btn-sm clear-btn" data-file="${escapeHtml(key)}">Clear</button>` : ''}
      </div>
      ${renderFoodPreview(result)}
      ${open && result ? `
        <div class="processing-card-detail">
          ${renderFrameSets(result, item)}
          ${renderMealSummary(result)}
        </div>` : ''}
    </div>`;
}

function itemMeta(item) {
  if (item.type !== 'recording') {
    return `${formatBytes(item.size)} · ${formatDate(item.capturedAt || item.modified)}`;
  }
  const parts = [];
  if (isVideoMeal(item)) {
    const count = item.videos?.length || 0;
    parts.push(`${count} clip${count === 1 ? '' : 's'}`);
    const length = formatDurationMinutes(mealDurationSec(item));
    if (length) parts.push(length);
  } else {
    const count = item.frameCount || item.frames?.length || 0;
    parts.push(`${count} frame${count === 1 ? '' : 's'}`);
  }
  parts.push(formatBytes(item.size));
  return parts.join(' · ');
}

function renderZoneBanner() {
  const allowFrames = isFrameRecordingsEnabled();
  const photoZoneCount = allowFrames ? (appSettings.zones?.length || 0) : 0;
  const videoZoneCount = appSettings.videoZones?.length || 0;
  const analysis = allowFrames
    ? 'Each meal is analyzed as a time-ordered set of frames. Video meals use the middle of every clip. Photo meals use up to 12 frames spread across the recording. Each plate zone is one consensus call.'
    : 'Each video is analyzed from the middle of every clip. Each plate zone is one consensus call.';
  const counts = [
    photoZoneCount ? `<strong>${photoZoneCount} photo zone${photoZoneCount === 1 ? '' : 's'}</strong>` : '',
    videoZoneCount ? `<strong>${videoZoneCount} video zone${videoZoneCount === 1 ? '' : 's'}</strong>` : '',
  ].filter(Boolean).join(' · ');

  return `
    <div class="card zone-config-banner" style="padding: 1rem; margin-bottom: 0;">
      <p style="font-size: 0.875rem; margin: 0;">
        ${counts ? `${counts} configured. ` : ''}${analysis}
      </p>
      ${photoZoneCount ? `
        <p style="font-size: 0.8rem; color: var(--color-text-muted); margin: 0.35rem 0 0;">
          Photos: ${appSettings.zones.map((z) => escapeHtml(z.name)).join(' · ')}
        </p>` : ''}
      ${videoZoneCount ? `
        <p style="font-size: 0.8rem; color: var(--color-text-muted); margin: 0.35rem 0 0;">
          Videos: ${appSettings.videoZones.map((z) => escapeHtml(z.name)).join(' · ')}
        </p>` : ''}
    </div>`;
}

function render() {
  const pendingFocus = takePendingFocus();
  const items = groupedItems();
  if (pendingFocus && items.some((item) => itemKey(item) === pendingFocus)) {
    expanded.add(pendingFocus);
  } else if (pendingFocus) {
    showToast('Could not find that meal in the processing list', 'info');
  }

  if (items.length === 0) {
    container().innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚡</div>
        <h3>No media to process</h3>
        <p>${isFrameRecordingsEnabled()
          ? 'Add meal photos or videos to the data/ folder first.'
          : 'Add meal videos to the data/ folder first.'}</p>
      </div>`;
    return;
  }

  const doneCount = items.filter((item) => getResultForFileKey(itemKey(item))).length;

  container().innerHTML = `
    ${renderZoneBanner()}
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
        Process All (${items.length - doneCount} remaining)
      </button>
      <div id="batch-progress" class="hidden" style="flex: 1; max-width: 300px;">
        <div class="progress-bar"><div class="progress-bar-fill" id="progress-fill" style="width: 0%"></div></div>
        <p style="font-size: 0.75rem; margin-top: 0.25rem;" id="progress-text">0 / 0</p>
      </div>
    </div>
    <div class="processing-list" id="processing-list">
      ${items.map((item) => renderProcessingCard(item)).join('')}
    </div>`;

  bindEvents();
  if (pendingFocus && expanded.has(pendingFocus)) scrollToCard(pendingFocus);
}

function bindEvents() {
  document.getElementById('process-all-btn')?.addEventListener('click', processAll);

  document.querySelectorAll('.process-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.kind === 'meal') processMeal(btn.dataset.file);
      else processFile(btn.dataset.file);
    });
  });

  document.querySelectorAll('.toggle-results-btn').forEach((btn) => {
    btn.addEventListener('click', () => toggleResults(btn.dataset.file));
  });

  document.querySelectorAll('.clear-btn').forEach((btn) => {
    btn.addEventListener('click', () => clearCache(btn.dataset.file));
  });
}

function cardFor(fileKey) {
  return document.querySelector(`.processing-card[data-file="${CSS.escape(fileKey)}"]`);
}

function updateRowStatus(fileKey, status) {
  const card = cardFor(fileKey);
  if (!card) return;
  card.querySelector('.status-badge').innerHTML = statusBadge(status);
  const btn = card.querySelector('.process-btn');
  if (btn) {
    btn.disabled = status === 'processing';
    btn.textContent = status === 'done' ? 'Re-process' : 'Process';
  }
}

function scrollToCard(fileKey) {
  const card = cardFor(fileKey);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card.classList.add('processing-row-highlight');
  setTimeout(() => card.classList.remove('processing-row-highlight'), 2200);
}

function rerenderKeepingContext() {
  const userContext = getUserContext();
  render();
  restoreUserContext(userContext);
}

function toggleResults(fileKey) {
  if (expanded.has(fileKey)) expanded.delete(fileKey);
  else expanded.add(fileKey);
  rerenderKeepingContext();
  if (expanded.has(fileKey)) scrollToCard(fileKey);
}

function resolveFocusKey(fileKey) {
  const parts = String(fileKey || '').split('/');
  if (parts[0] === 'recordings' && parts.length >= 2) {
    const mealPath = `recordings/${parts[1]}`;
    if (groupedItems().some((item) => item.path === mealPath)) return mealPath;
  }
  return fileKey;
}

function takePendingFocus() {
  try {
    const raw = sessionStorage.getItem(PROCESSING_FOCUS_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PROCESSING_FOCUS_KEY);
    const payload = JSON.parse(raw);
    return resolveFocusKey(payload.path || payload.name) || null;
  } catch {
    sessionStorage.removeItem(PROCESSING_FOCUS_KEY);
    return null;
  }
}

async function clearCache(fileKey, reRender = true) {
  const file = findFileRecord(fileKey);
  const filename = file ? getFileKey(file) : fileKey;
  const item = groupedItems().find((entry) => itemKey(entry) === fileKey);
  const label = item ? itemLabel(item) : (file?.name || filename);

  try {
    await apiFetch(`/api/process/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    delete results[filename];
    delete results[String(filename).split('/').pop()];
    expanded.delete(fileKey);
    expanded.delete(filename);
    showToast(`Cleared saved analysis for ${label}`, 'info');
    if (reRender) render();
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

async function processMeal(mealPath) {
  if (processing.has(mealPath)) return;

  const meal = groupedItems().find((item) => item.type === 'recording' && item.path === mealPath);
  const label = meal ? mealLabel(meal) : mealPath;
  if (getResultForFileKey(mealPath)) {
    const cleared = await clearCache(mealPath, false);
    if (!cleared) return;
  }

  processing.add(mealPath);
  updateRowStatus(mealPath, 'processing');
  const userContext = getUserContext();
  let summary = null;

  try {
    const data = await apiFetch('/api/process-meal', {
      method: 'POST',
      body: JSON.stringify({
        mealPath,
        userContext: userContext || undefined,
      }),
    });
    results[mealPath] = data.result;
    summary = data.result;
    showToast(`${label} analyzed`, 'success');
  } catch (err) {
    updateRowStatus(mealPath, 'error');
    showToast(err.message || PROCESSING_ERROR_MSG, 'error');
  } finally {
    processing.delete(mealPath);
    if (summary) expanded.add(mealPath);
    render();
    restoreUserContext(userContext);
    if (summary) scrollToCard(mealPath);
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
    const cleared = await clearCache(fileKey, false);
    if (!cleared) return;
  }

  processing.add(fileKey);
  updateRowStatus(fileKey, 'processing');

  const userContext = getUserContext();
  let summary = null;

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
    summary = data.result;
    showToast(
      mediaType === 'video'
        ? `${file?.name || filename} processed (frame ${Number(pick.frameTimeSec || 0).toFixed(1)}s)`
        : `${file?.name || filename} processed successfully`,
      'success',
    );
  } catch (err) {
    updateRowStatus(fileKey, 'error');
    showToast(PROCESSING_ERROR_MSG, 'error');
  } finally {
    processing.delete(fileKey);
    if (summary) expanded.add(fileKey);
    render();
    restoreUserContext(userContext);
    if (summary) scrollToCard(fileKey);
  }
}

async function processAll() {
  const pending = groupedItems().filter((item) => !getResultForFileKey(itemKey(item)));
  if (pending.length === 0) {
    showToast('All meals already processed', 'info');
    return;
  }

  const userContext = getUserContext();
  const progressWrap = document.getElementById('batch-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  progressWrap.classList.remove('hidden');
  document.getElementById('process-all-btn').disabled = true;

  let completed = 0;
  const total = pending.length;
  let lastKey = null;

  for (const item of pending) {
    const key = itemKey(item);

    if (item.type !== 'recording') {
      const { zones, orientationDeg, mediaType } = zonesForFile(item);
      const pick = await confirmZoneProcessing({
        filename: item.name,
        filePath: key,
        zones,
        orientationDeg,
        mediaType,
      });
      if (!pick?.confirmed) {
        showToast('Batch processing cancelled', 'info');
        break;
      }

      processing.add(key);
      updateRowStatus(key, 'processing');
      try {
        const body = {
          filename: key,
          userContext: userContext || undefined,
        };
        if (mediaType === 'video' && Number.isFinite(Number(pick.frameTimeSec))) {
          body.frameTimeSec = Number(pick.frameTimeSec);
        }
        const data = await apiFetch('/api/process', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        results[key] = data.result;
        lastKey = key;
      } catch (err) {
        updateRowStatus(key, 'error');
        showToast(PROCESSING_ERROR_MSG, 'error');
      } finally {
        processing.delete(key);
        completed += 1;
        progressFill.style.width = `${(completed / total) * 100}%`;
        progressText.textContent = `${completed} / ${total}`;
      }
      continue;
    }

    processing.add(key);
    updateRowStatus(key, 'processing');
    try {
      const data = await apiFetch('/api/process-meal', {
        method: 'POST',
        body: JSON.stringify({
          mealPath: key,
          userContext: userContext || undefined,
        }),
      });
      results[key] = data.result;
      lastKey = key;
    } catch (err) {
      updateRowStatus(key, 'error');
      showToast(err.message || PROCESSING_ERROR_MSG, 'error');
    } finally {
      processing.delete(key);
      completed += 1;
      progressFill.style.width = `${(completed / total) * 100}%`;
      progressText.textContent = `${completed} / ${total}`;
    }
  }

  if (completed > 0) {
    showToast(`Batch complete: ${completed}/${total} processed`, 'success');
  }
  if (lastKey) expanded.add(lastKey);
  render();
  restoreUserContext(userContext);
  if (lastKey) scrollToCard(lastKey);
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    [files, results, appSettings] = await Promise.all([
      apiFetch('/api/files'),
      apiFetch('/api/results'),
      apiFetch('/api/settings'),
    ]);
    applySettingsFlags(appSettings);
    render();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <h3>Failed to load processing data</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}
