import { apiFetch, formatBytes, formatDate, showToast } from './utils.js';
import {
  getActiveZoneName,
  renderGalleryAnalysisPanel,
  renderMealSummary,
} from './mealResults.js';
import { mountZoneOverlay, highlightZoneOverlay } from './zoneOverlay.js';

function fileApiUrl(relativePath) {
  return `/api/file/${String(relativePath || '').split('/').map(encodeURIComponent).join('/')}`;
}

let allFiles = [];
let filteredFiles = [];
let results = {};
let appSettings = { zones: [], videoZones: [] };
let lightboxIndex = -1;

const container = () => document.getElementById('gallery-content');

const PROCESSING_FOCUS_KEY = 'processingFocus';

function getFileKey(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  return file.path || file.name || '';
}

function getResultForFile(file) {
  const path = getFileKey(file);
  if (!path) return null;
  return results[path] || results[path.split('/').pop()] || null;
}

function goToProcessingForFrame(frame) {
  const path = getFileKey(frame);
  if (!path) return;

  sessionStorage.setItem(PROCESSING_FOCUS_KEY, JSON.stringify({
    path,
    name: frame.name || path.split('/').pop(),
  }));

  closeLightbox();
  document.querySelector('.nav-item[data-tab="processing"]')?.click();
}

function renderFrameResultsSnippet(frame) {
  const result = getResultForFile(frame);
  if (!result) {
    return '<p class="recording-frame-no-results">Not processed</p>';
  }
  return `<div class="recording-frame-results-snippet">${renderMealSummary(result, { compact: true })}</div>`;
}

function renderRecordingFrameList(frames, activeIndex = 0) {
  return `
    <div class="recording-frame-list" id="recording-frame-list">
      ${frames.map((frame, i) => {
        const processed = Boolean(getResultForFile(frame));
        return `
          <div class="recording-frame-item${i === activeIndex ? ' is-active' : ''}" data-frame-index="${i}">
            <button type="button" class="recording-frame-thumb-btn" aria-label="Show frame ${i + 1}">
              <img src="${fileApiUrl(frame.path)}" alt="" loading="lazy">
            </button>
            <div class="recording-frame-item-body">
              <div class="recording-frame-item-header">
                <span class="recording-frame-item-name" title="${escapeAttr(frame.name)}">${escapeAttr(frame.name)}</span>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm recording-frame-process-btn"
                  data-frame-path="${escapeAttr(frame.path)}"
                >${processed ? 'Processing tab' : 'Process'}</button>
              </div>
              ${renderFrameResultsSnippet(frame)}
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

function syncRecordingFrameListActive(lb, frameIndex) {
  lb.querySelectorAll('.recording-frame-item').forEach((item) => {
    item.classList.toggle('is-active', Number(item.dataset.frameIndex) === frameIndex);
  });
}

function bindRecordingFrameList(lb, frames, onSelectFrame) {
  lb.querySelectorAll('.recording-frame-thumb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.recording-frame-item');
      const index = Number(item?.dataset.frameIndex);
      if (!Number.isFinite(index)) return;
      onSelectFrame(index);
    });
  });

  lb.querySelectorAll('.recording-frame-process-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = btn.dataset.framePath;
      const frame = frames.find((f) => f.path === path);
      if (frame) goToProcessingForFrame(frame);
    });
  });
}

function getFilterState() {
  const search = document.getElementById('gallery-search')?.value.toLowerCase() || '';
  const dateFrom = document.getElementById('gallery-date-from')?.value;
  const dateTo = document.getElementById('gallery-date-to')?.value;
  const typeBtn = document.querySelector('#gallery-type-toggle button.active');
  const typeFilter = typeBtn?.dataset.type || 'all';
  return { search, dateFrom, dateTo, typeFilter };
}

function computeFilteredFiles() {
  const { search, dateFrom, dateTo, typeFilter } = getFilterState();

  return allFiles.filter((f) => {
    if (search && !f.name.toLowerCase().includes(search)) return false;
    if (typeFilter !== 'all') {
      if (typeFilter === 'video') {
        if (f.type !== 'video' && f.type !== 'recording') return false;
      } else if (f.type !== typeFilter) {
        return false;
      }
    }

    const modDate = f.modified.split('T')[0];
    if (dateFrom && modDate < dateFrom) return false;
    if (dateTo && modDate > dateTo) return false;

    return true;
  });
}

function escapeAttr(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const VIDEO_DOWNSAMPLE_FPS = [1, 2, 5, 10, 15, 30];

function formatFps(fps) {
  if (fps == null || !Number.isFinite(Number(fps))) return 'Unknown FPS';
  const n = Number(fps);
  return Number.isInteger(n) ? `${n} fps` : `${n.toFixed(2).replace(/\.?0+$/, '')} fps`;
}

/** Always show size in MB for video clips (e.g. "12.4 MB"). */
function formatSizeMb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatClipStats(clip) {
  const parts = [];
  const size = formatSizeMb(clip?.size);
  if (size) parts.push(size);
  if (clip?.fps != null && Number.isFinite(Number(clip.fps))) parts.push(formatFps(clip.fps));
  return parts.join(' · ') || '—';
}

function formatClipPickLabel(clip, index) {
  const stats = formatClipStats(clip);
  return `Clip ${index + 1}: ${clip.name}${stats && stats !== '—' ? ` · ${stats}` : ''}`;
}

function downsampleOptionsHtml(currentFps) {
  const current = Number(currentFps);
  const hasCurrent = Number.isFinite(current) && current > 0;
  const options = VIDEO_DOWNSAMPLE_FPS.filter((fps) => !hasCurrent || fps < current - 0.05);
  if (!options.length) {
    return '<option value="">Already at lowest rate</option>';
  }
  return options.map((fps, i) => (
    `<option value="${fps}" ${i === 0 ? 'selected' : ''}>${fps} fps</option>`
  )).join('');
}

function renderVideoFpsPanel(clip, { idPrefix = 'gallery-video' } = {}) {
  const currentLabel = formatClipStats(clip);
  const disabled = !clip?.path;
  const options = downsampleOptionsHtml(clip?.fps);
  const noOptions = !VIDEO_DOWNSAMPLE_FPS.some((fps) => {
    const current = Number(clip?.fps);
    return !Number.isFinite(current) || fps < current - 0.05;
  });

  return `
    <div class="gallery-video-fps-panel" data-clip-path="${escapeAttr(clip?.path || '')}">
      <div class="gallery-video-fps-header">
        <h4>Video FPS</h4>
        <span class="gallery-video-fps-current">${currentLabel}</span>
      </div>
      <div class="gallery-video-fps-row">
        <label for="${idPrefix}-fps-select" class="gallery-video-fps-label">Downsample to</label>
        <select id="${idPrefix}-fps-select" class="gallery-video-fps-select" ${disabled || noOptions ? 'disabled' : ''}>
          ${options}
        </select>
        <button type="button" class="btn btn-primary btn-sm gallery-video-fps-apply" ${disabled || noOptions ? 'disabled' : ''}>
          Apply
        </button>
      </div>
      <div class="gallery-video-fps-progress" hidden>
        <div class="progress-bar"><div class="progress-bar-fill gallery-video-fps-progress-fill" style="width: 0%"></div></div>
        <p class="gallery-video-fps-progress-text">Starting…</p>
      </div>
      <p class="gallery-video-fps-hint">Re-encodes this clip in place. Duration stays the same.</p>
    </div>`;
}

function updateVideoFileMeta(filePath, patch) {
  const apply = (file) => {
    if (!file || file.path !== filePath) return;
    Object.assign(file, patch);
  };

  allFiles.forEach(apply);
  filteredFiles.forEach((file) => {
    apply(file);
    if (file.type === 'recording' && Array.isArray(file.videos)) {
      file.videos.forEach((clip) => {
        if (clip.path === filePath) Object.assign(clip, patch);
      });
      if (file.videos.length) {
        file.size = file.videos.reduce((sum, v) => sum + (v.size || 0), 0);
      }
    }
  });
}

function formatEta(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 1) return 'almost done';
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `~${m}m ${rem}s left` : `~${m}m left`;
}

function setFpsProgress(panel, { hidden = false, percent = 0, text = '' } = {}) {
  const wrap = panel?.querySelector('.gallery-video-fps-progress');
  const fill = panel?.querySelector('.gallery-video-fps-progress-fill');
  const label = panel?.querySelector('.gallery-video-fps-progress-text');
  if (!wrap) return;
  wrap.hidden = hidden;
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (label) label.textContent = text || '';
}

async function pollFpsJob(jobId, { onProgress = null, intervalMs = 400 } = {}) {
  for (;;) {
    let job;
    try {
      job = await apiFetch(`/api/files/video-fps/jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      const msg = String(err?.message || '');
      if (/not found/i.test(msg)) {
        throw new Error(
          'Encode was interrupted (server restarted or job lost). The clip was not changed — try Apply again.',
        );
      }
      throw err;
    }
    onProgress?.(job);
    if (job.status === 'done') {
      if (!job.result) {
        throw new Error('Encode finished but returned no result. The clip may not have changed — try Apply again.');
      }
      return job.result;
    }
    if (job.status === 'error') {
      throw new Error(job.error || 'FPS postprocess failed');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function releaseVideoElement(videoEl) {
  if (!videoEl) return { wasPaused: true, t: 0 };
  const wasPaused = videoEl.paused;
  const t = videoEl.currentTime || 0;
  try { videoEl.pause?.(); } catch { /* ignore */ }
  // Drop the HTTP media handle so Windows can replace the file after encode.
  try {
    videoEl.removeAttribute('src');
    videoEl.load?.();
  } catch { /* ignore */ }
  return { wasPaused, t };
}

async function applyVideoFpsDownsample(clipPath, targetFps, {
  videoEl = null,
  panel = null,
  onUpdated = null,
} = {}) {
  if (!clipPath || !targetFps) return;

  const applyBtn = panel?.querySelector('.gallery-video-fps-apply');
  const select = panel?.querySelector('.gallery-video-fps-select');
  if (applyBtn) applyBtn.disabled = true;
  if (select) select.disabled = true;
  setFpsProgress(panel, { hidden: false, percent: 0, text: 'Starting encode…' });

  const playback = releaseVideoElement(videoEl);

  try {
    const start = await apiFetch('/api/files/video-fps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: clipPath, targetFps }),
    });

    let result = start;
    if (start.async && start.jobId) {
      result = await pollFpsJob(start.jobId, {
        onProgress: (job) => {
          const pct = Number.isFinite(Number(job.percent)) ? Number(job.percent) : 0;
          const eta = Number.isFinite(Number(job.etaSec)) ? formatEta(job.etaSec) : 'estimating…';
          const pctLabel = Number.isFinite(Number(job.percent))
            ? `${Math.round(pct)}%`
            : 'encoding';
          // ffmpeg hits 100% before the file replace finishes — keep that distinction.
          const phase = job.percent >= 100 && job.status === 'running'
            ? 'finishing…'
            : `${pctLabel} · ${eta}`;
          setFpsProgress(panel, {
            hidden: false,
            percent: pct,
            text: phase,
          });
        },
      });
    }

    if (!result?.skipped && !result?.changed && result?.fps == null) {
      throw new Error('Encode did not update the clip. Try Apply again.');
    }

    setFpsProgress(panel, {
      hidden: false,
      percent: 100,
      text: result?.skipped ? 'Already at target FPS' : 'Done',
    });

    updateVideoFileMeta(clipPath, {
      fps: result.fps,
      size: result.size,
      modified: result.capturedAt || result.modified || new Date().toISOString(),
      capturedAt: result.capturedAt || result.modified,
      postprocessedAt: result.postprocessedAt || undefined,
      thumbPath: result.thumbPath ?? undefined,
    });

    if (videoEl) {
      videoEl.src = `${fileApiUrl(clipPath)}?t=${Date.now()}`;
      videoEl.addEventListener('loadedmetadata', () => {
        try { videoEl.currentTime = Math.min(playback.t, videoEl.duration || playback.t); } catch { /* ignore */ }
        if (!playback.wasPaused) videoEl.play?.();
      }, { once: true });
    }

    renderGrid();
    onUpdated?.(result);
    showToast(
      result.skipped
        ? (result.message || 'Already at that FPS')
        : `Reduced clip to ${formatFps(result.fps)}`,
      result.skipped ? 'info' : 'success',
    );
    setTimeout(() => setFpsProgress(panel, { hidden: true }), 1200);
    return result;
  } catch (err) {
    // Restore playback from the original path if encode aborted.
    if (videoEl && !videoEl.getAttribute('src')) {
      videoEl.src = `${fileApiUrl(clipPath)}?t=${Date.now()}`;
    }
    showToast(err.message, 'error');
    setFpsProgress(panel, { hidden: true });
    if (applyBtn) applyBtn.disabled = false;
    if (select) select.disabled = false;
    return null;
  }
}

function bindVideoFpsPanel(root, getClip, {
  videoEl = null,
  getVideoEl = null,
  onUpdated = null,
} = {}) {
  const panel = root.querySelector('.gallery-video-fps-panel');
  if (!panel) return;

  panel.querySelector('.gallery-video-fps-apply')?.addEventListener('click', async () => {
    const clip = getClip();
    const select = panel.querySelector('.gallery-video-fps-select');
    const targetFps = Number(select?.value) || 0;
    if (!clip?.path || !targetFps) return;
    const el = (typeof getVideoEl === 'function' ? getVideoEl() : null) || videoEl;
    await applyVideoFpsDownsample(clip.path, targetFps, {
      videoEl: el,
      panel,
      onUpdated: (result) => {
        refreshVideoFpsPanel(panel, { ...clip, fps: result.fps, size: result.size });
        onUpdated?.(result);
      },
    });
  });
}

function refreshVideoFpsPanel(panel, clip) {
  if (!panel) return;
  panel.dataset.clipPath = clip?.path || '';
  const current = panel.querySelector('.gallery-video-fps-current');
  if (current) current.textContent = formatClipStats(clip);
  const select = panel.querySelector('.gallery-video-fps-select');
  const applyBtn = panel.querySelector('.gallery-video-fps-apply');
  if (select) {
    select.innerHTML = downsampleOptionsHtml(clip?.fps);
    const noOptions = select.options.length === 1 && !select.options[0].value;
    select.disabled = !clip?.path || noOptions;
    if (applyBtn) applyBtn.disabled = select.disabled;
  }
}

function findGalleryCard(itemPath) {
  const grid = document.getElementById('gallery-grid');
  if (!grid || !itemPath) return null;
  return grid.querySelector(`[data-item-path="${escapeAttr(itemPath)}"]`);
}

function reindexGalleryCards() {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;
  grid.querySelectorAll('.gallery-card').forEach((card, idx) => {
    card.dataset.index = String(idx);
  });
}

function showGridEmptyState() {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="empty-state" style="grid-column: 1/-1;">
      <div class="empty-state-icon">🖼️</div>
      <h3>No files found</h3>
      <p>${allFiles.length === 0 ? 'Add photos to the data/ folder to get started.' : 'Try adjusting your filters.'}</p>
    </div>`;
}

function updateRecordingCardInPlace(recordingPath) {
  const card = findGalleryCard(recordingPath);
  const entry = allFiles.find((f) => f.path === recordingPath);
  if (!card || !entry?.frames?.length) return;

  const thumb = card.querySelector('.gallery-recording-thumb img');
  const firstFrame = entry.frames[0];
  if (thumb && firstFrame) {
    thumb.src = `${fileApiUrl(firstFrame.path)}`;
    thumb.alt = entry.name;
  }

  const badge = card.querySelector('.gallery-recording-badge');
  if (badge) {
    badge.textContent = `🎬 ${entry.frameCount} frame${entry.frameCount === 1 ? '' : 's'}`;
  }

  const sizeEl = card.querySelector('.gallery-card-meta span');
  if (sizeEl) sizeEl.textContent = formatBytes(entry.size);
}

function removeTrashPathFromState(itemPath) {
  if (/^recordings\/[^/]+$/.test(itemPath)) {
    const entry = allFiles.find((f) => f.path === itemPath);
    entry?.frames?.forEach((frame) => delete results[frame.name]);
    allFiles = allFiles.filter((f) => f.path !== itemPath);
    return { kind: 'recording', path: itemPath };
  }

  if (itemPath.startsWith('recordings/')) {
    const session = itemPath.split('/')[1];
    const recordingPath = `recordings/${session}`;
    const entry = allFiles.find((f) => f.type === 'recording' && f.path === recordingPath);
    if (!entry) return null;

    entry.frames = entry.frames.filter((frame) => frame.path !== itemPath);
    delete results[itemPath];
    delete results[itemPath.split('/').pop()];

    if (!entry.frames.length) {
      allFiles = allFiles.filter((f) => f.path !== recordingPath);
      return { kind: 'recording', path: recordingPath };
    }

    entry.frameCount = entry.frames.length;
    entry.size = entry.frames.reduce((sum, fr) => sum + (fr.size || 0), 0);
    entry.modified = entry.frames[entry.frames.length - 1]?.modified || entry.modified;
    return { kind: 'frame', path: itemPath, recordingPath };
  }

  const baseName = itemPath.split('/').pop();
  delete results[baseName];
  allFiles = allFiles.filter((f) => (f.path || f.name) !== itemPath);
  return { kind: 'file', path: itemPath };
}

function applyGalleryTrashRemoval(itemPath) {
  const result = removeTrashPathFromState(itemPath);
  if (!result) return;

  filteredFiles = computeFilteredFiles();

  if (result.kind === 'frame') {
    updateRecordingCardInPlace(result.recordingPath);
    return;
  }

  findGalleryCard(result.path)?.remove();
  reindexGalleryCards();

  const grid = document.getElementById('gallery-grid');
  if (grid && !grid.querySelector('.gallery-card')) {
    showGridEmptyState();
  }
}

async function trashItem(itemPath, label, { closeOnSuccess = true } = {}) {
  if (!window.confirm(`Move "${label}" to trash?`)) return false;

  try {
    await apiFetch('/api/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: itemPath }),
    });
    showToast(`Moved to trash: ${label}`, 'info');
    if (closeOnSuccess) closeLightbox();
    applyGalleryTrashRemoval(itemPath);
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

function renderCardDeleteButton(itemPath, label) {
  return `
    <button type="button" class="btn btn-ghost btn-sm gallery-card-delete" data-trash-path="${itemPath}" data-trash-label="${label.replace(/"/g, '&quot;')}" aria-label="Move to trash" title="Move to trash">🗑️</button>`;
}

function renderCardRotateButtons(filePath, fileName) {
  const path = filePath || fileName;
  return `
    <button type="button" class="btn btn-ghost btn-sm gallery-card-rotate gallery-card-rotate-ccw" data-rotate-path="${path.replace(/"/g, '&quot;')}" data-rotate-name="${fileName.replace(/"/g, '&quot;')}" data-rotate-degrees="270" aria-label="Rotate left" title="Rotate left 90°">↺</button>
    <button type="button" class="btn btn-ghost btn-sm gallery-card-rotate gallery-card-rotate-cw" data-rotate-path="${path.replace(/"/g, '&quot;')}" data-rotate-name="${fileName.replace(/"/g, '&quot;')}" data-rotate-degrees="90" aria-label="Rotate right" title="Rotate right 90°">↻</button>`;
}

function renderLightboxRotateToolbar() {
  return `
    <div class="lightbox-photo-toolbar" aria-label="Rotate image">
      <button type="button" class="btn btn-ghost btn-sm lightbox-rotate-ccw" title="Rotate left 90°">↺</button>
      <button type="button" class="btn btn-ghost btn-sm lightbox-rotate-cw" title="Rotate right 90°">↻</button>
    </div>`;
}

function bindCardDeleteButtons(grid) {
  grid.querySelectorAll('.gallery-card-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      trashItem(btn.dataset.trashPath, btn.dataset.trashLabel);
    });
  });
}

function bindCardRotateButtons(grid) {
  grid.querySelectorAll('.gallery-card-rotate').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.gallery-card');
      rotateGalleryImage(
        { path: btn.dataset.rotatePath, name: btn.dataset.rotateName },
        Number(btn.dataset.rotateDegrees) || 90,
        { cardElement: card },
      );
    });
  });
}

function bindLightboxRotateButtons(lb, fileRef, getFileRef) {
  const bind = (selector, degrees) => {
    lb.querySelector(selector)?.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = getFileRef ? getFileRef() : fileRef;
      if (!target) return;
      rotateGalleryImage(target, degrees, { lightbox: lb });
    });
  };

  bind('.lightbox-rotate-ccw', 270);
  bind('.lightbox-rotate-cw', 90);
}

export function groupFiles(files) {
  const sessions = new Map();
  const others = [];

  for (const f of files) {
    const parts = (f.path || f.name).split('/');
    if (parts[0] === 'recordings' && parts.length >= 3 && (f.type === 'image' || f.type === 'video')) {
      const session = parts[1];
      if (!sessions.has(session)) sessions.set(session, { images: [], videos: [] });
      if (f.type === 'video') sessions.get(session).videos.push(f);
      else sessions.get(session).images.push(f);
    } else {
      others.push(f);
    }
  }

  const recordingEntries = [];
  for (const [session, { images, videos }] of sessions) {
    images.sort((a, b) => new Date(a.modified) - new Date(b.modified) || a.name.localeCompare(b.name));
    videos.sort((a, b) => new Date(a.modified) - new Date(b.modified) || a.name.localeCompare(b.name));

    if (images.length) {
      const totalSize = images.reduce((sum, fr) => sum + (fr.size || 0), 0);
      recordingEntries.push({
        type: 'recording',
        mode: 'timelapse',
        session,
        name: `Recording ${session}`,
        path: `recordings/${session}`,
        frames: images,
        frameCount: images.length,
        videos,
        size: totalSize,
        modified: images[images.length - 1]?.modified || new Date().toISOString(),
      });
    } else if (videos.length) {
      const totalSize = videos.reduce((sum, v) => sum + (v.size || 0), 0);
      recordingEntries.push({
        type: 'recording',
        mode: 'video',
        session,
        name: `Video ${session}`,
        path: `recordings/${session}`,
        frames: [],
        frameCount: 0,
        videos,
        size: totalSize,
        modified: videos[videos.length - 1]?.modified || new Date().toISOString(),
      });
    }
  }

  return [...recordingEntries, ...others]
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function renderSkeleton() {
  container().innerHTML = `
    <div class="gallery-grid">
      ${Array(6).fill('<div class="skeleton skeleton-card"></div>').join('')}
    </div>`;
}

function renderFilters() {
  return `
    <div class="gallery-filters glass" style="padding: 1rem;">
      <input type="search" id="gallery-search" placeholder="Search by filename..." aria-label="Search files">
      <input type="date" id="gallery-date-from" aria-label="Date from">
      <input type="date" id="gallery-date-to" aria-label="Date to">
      <div class="toggle-group" id="gallery-type-toggle">
        <button class="active" data-type="all">All</button>
        <button data-type="image">Images</button>
        <button data-type="video">Videos</button>
      </div>
    </div>`;
}

function applyFilters() {
  filteredFiles = computeFilteredFiles();
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  if (filteredFiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <div class="empty-state-icon">🖼️</div>
        <h3>No files found</h3>
        <p>${allFiles.length === 0 ? 'Add photos to the data/ folder to get started.' : 'Try adjusting your filters.'}</p>
      </div>`;
    return;
  }

  grid.innerHTML = filteredFiles.map((file, idx) => {
    if (file.type === 'recording') {
      const isVideoRec = file.mode === 'video' || (!file.frames?.length && file.videos?.length);
      const thumbSrc = file.frames?.[0]
        ? `${fileApiUrl(file.frames[0].path)}`
        : (file.videos?.[0]?.thumbPath
          ? `${fileApiUrl(file.videos[0].thumbPath)}`
          : '');
      const badge = isVideoRec
        ? `🎥 ${file.videos.length} clip${file.videos.length === 1 ? '' : 's'}`
        : `🎬 ${file.frameCount} frame${file.frameCount === 1 ? '' : 's'}`;
      return `
        <div class="card gallery-card" data-index="${idx}" data-item-path="${escapeAttr(file.path)}" tabindex="0" role="button" aria-label="Play ${file.name}">
          <div class="gallery-card-actions">
            ${renderCardDeleteButton(file.path, file.name)}
          </div>
          <div class="gallery-card-thumb gallery-recording-thumb">
            ${thumbSrc ? `<img src="${thumbSrc}" alt="${file.name}" loading="lazy">` : '<div class="gallery-video-placeholder" aria-hidden="true">🎥</div>'}
            <span class="gallery-recording-play" aria-hidden="true">▶</span>
            <span class="gallery-recording-badge">${badge}</span>
          </div>
          <div class="gallery-card-body">
            <div class="gallery-card-name" title="${file.name}">${file.name}</div>
            <div class="gallery-card-meta">
              <span>${formatBytes(file.size)}</span>
              <span class="badge badge-muted">${isVideoRec ? 'Video' : 'Recording'}</span>
              ${isVideoRec && file.videos?.[0]?.fps != null ? `<span>${formatFps(file.videos[0].fps)}</span>` : ''}
            </div>
          </div>
        </div>`;
    }

    const isProcessed = !!results[file.name];
    const thumbSrc = file.type === 'image'
      ? `${fileApiUrl(file.path || file.name)}`
      : (file.thumbPath ? `${fileApiUrl(file.thumbPath)}` : '');

    return `
      <div class="card gallery-card" data-index="${idx}" data-item-path="${escapeAttr(file.path || file.name)}" tabindex="0" role="button" aria-label="View ${file.name}">
        <div class="gallery-card-actions">
          ${file.type === 'image' ? renderCardRotateButtons(file.path || file.name, file.name) : ''}
          ${renderCardDeleteButton(file.path || file.name, file.name)}
        </div>
        ${thumbSrc
          ? `<img class="gallery-card-thumb" src="${thumbSrc}" alt="${file.name}" loading="lazy">`
          : `<div class="gallery-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:2rem;">🎬</div>`}
        <div class="gallery-card-body">
          <div class="gallery-card-name" title="${file.name}">${file.name}</div>
          <div class="gallery-card-meta">
            <span>${formatBytes(file.size)}</span>
            ${file.type === 'video' && file.fps != null ? `<span>${formatFps(file.fps)}</span>` : ''}
            ${isProcessed ? '<span class="badge badge-success">Processed</span>' : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.gallery-card').forEach((card) => {
    card.addEventListener('click', () => openLightbox(parseInt(card.dataset.index, 10)));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openLightbox(parseInt(card.dataset.index, 10));
      }
    });
  });
  bindCardDeleteButtons(grid);
  bindCardRotateButtons(grid);
}

async function rotateGalleryImage(file, degrees, { lightbox = null, cardElement = null } = {}) {
  const filePath = file.path || file.name;
  const fileName = file.name || filePath.split('/').pop();
  const buttons = [
    ...(lightbox ? lightbox.querySelectorAll('.lightbox-rotate-ccw, .lightbox-rotate-cw, .lightbox-photo-toolbar button') : []),
    ...(cardElement ? cardElement.querySelectorAll('.gallery-card-rotate') : []),
  ];

  buttons.forEach((btn) => { btn.disabled = true; });

  try {
    await apiFetch('/api/files/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, degrees }),
    });

    if (getResultForFile({ path: filePath, name: fileName })) {
      try {
        const resultKey = getFileKey({ path: filePath, name: fileName });
        await apiFetch(`/api/process/${encodeURIComponent(resultKey)}`, { method: 'DELETE' });
        delete results[filePath];
        delete results[fileName];
      } catch {
        /* ignore cache clear errors */
      }
    }

    const cacheBustedSrc = `${fileApiUrl(filePath)}?t=${Date.now()}`;

    const lightboxImg = lightbox?.querySelector('.lightbox-photo-host img, .rp-frame');
    if (lightboxImg) {
      lightboxImg.src = cacheBustedSrc;
      if (appSettings.zones?.length && lightbox.querySelector('.lightbox-photo-host img')) {
        lightboxImg.onload = () => drawLightboxZones(lightbox);
      }
    }

    const cardImg = cardElement?.querySelector('.gallery-card-thumb');
    if (cardImg) {
      cardImg.src = cacheBustedSrc;
    }

    if (lightbox?.querySelector('.lightbox-analysis-body')) {
      const analysisFile = { name: fileName, path: filePath };
      lightbox.querySelector('.lightbox-analysis-body').innerHTML = renderResultsPanel(analysisFile);
      bindAnalysisTabs(lightbox, analysisFile);
    }

    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}

function zonesForGalleryFile(file) {
  if (file?.type === 'video' || file?.mode === 'video') {
    return {
      zones: appSettings.videoZones || [],
      orientationDeg: appSettings.referenceVideoOrientation,
    };
  }
  return {
    zones: appSettings.zones || [],
    orientationDeg: appSettings.referenceOrientation,
  };
}

function renderResultsPanel(file, activeTabId = 'all') {
  const result = getResultForFile(file);
  if (!result) {
    return `
      <p class="recording-frame-no-results">No AI results yet.</p>
      <button type="button" class="btn btn-primary btn-sm gallery-inline-process-btn">Process</button>`;
  }

  const { zones } = zonesForGalleryFile(file);
  let html = `<p class="analysis-processed-at"><strong>Processed:</strong> ${formatDate(result.processedAt)}</p>`;
  html += renderGalleryAnalysisPanel(result, zones, activeTabId, file);
  return html;
}

function updateRecordingFrameAnalysis(lb, frame) {
  lb._analysisFile = frame;

  const nameEl = lb.querySelector('#recording-current-frame-name');
  if (nameEl) nameEl.textContent = frame.name;

  const body = lb.querySelector('.recording-current-analysis-body');
  if (body) body.innerHTML = renderResultsPanel(frame);
}

function bindLightboxInteractions(lb, initialFile = null) {
  if (initialFile) lb._analysisFile = initialFile;
  if (lb.dataset.lightboxBound) return;
  lb.dataset.lightboxBound = '1';

  lb.addEventListener('click', (event) => {
    const processBtn = event.target.closest('.gallery-inline-process-btn');
    if (processBtn && lb.contains(processBtn)) {
      event.stopPropagation();
      if (lb._analysisFile) goToProcessingForFrame(lb._analysisFile);
      return;
    }

    const tab = event.target.closest('[data-zone-tab]');
    if (!tab || !lb.contains(tab)) return;

    const body = tab.closest('.lightbox-analysis-body');
    if (!body) return;

    const file = lb._analysisFile;
    const result = file ? getResultForFile(file) : null;
    if (!file || !result) return;

    const activeTabId = tab.dataset.zoneTab;
    body.innerHTML = renderResultsPanel(file, activeTabId);

    const host = lb.querySelector('.lightbox-photo-host, .lightbox-video-host, .recording-lightbox-viewport');
    if (host) {
      const { zones } = zonesForGalleryFile(file);
      if (zones?.length) {
        highlightZoneOverlay(host, getActiveZoneName(result, zones, activeTabId));
      }
    }
  });
}

function bindAnalysisTabs(lightbox, file) {
  bindLightboxInteractions(lightbox, file);
}

function drawLightboxZones(lightbox) {
  const img = lightbox.querySelector('.lightbox-photo-host img');
  const host = lightbox.querySelector('.lightbox-photo-host');
  const { zones, orientationDeg } = zonesForGalleryFile({ type: 'image' });
  if (!host || !img || !zones?.length) return;

  mountZoneOverlay(host, img, zones, orientationDeg);
  const result = results[lightbox.dataset.filename];
  const fileKey = lightbox.dataset.filepath || lightbox.dataset.filename;
  const fileResult = result || results[fileKey];
  if (fileResult) {
    highlightZoneOverlay(host, getActiveZoneName(fileResult, zones, 'all'));
  }
}

function drawLightboxVideoZones(lightbox, analysisFile = null) {
  const host = lightbox.querySelector('.lightbox-video-host, .recording-lightbox-viewport');
  if (!host) return;

  // Recover video if an older overlay path reparented it into a wrap.
  const trapped = host.querySelector('.zone-orient-wrap video');
  if (trapped) {
    trapped.removeAttribute('style');
    host.insertBefore(trapped, host.querySelector('.zone-orient-wrap'));
    host.querySelector('.zone-orient-wrap')?.remove();
  }
  host.querySelector('.zone-overlay-layer')?.remove();

  const video = host.querySelector('video');
  const { zones, orientationDeg } = zonesForGalleryFile({ type: 'video' });
  if (!video || !zones?.length) return;

  const mount = () => {
    if (!video.videoWidth || !host.clientWidth) return;
    mountZoneOverlay(host, video, zones, orientationDeg);
    const file = analysisFile || lightbox._analysisFile;
    const fileResult = file ? getResultForFile(file) : null;
    if (fileResult) {
      highlightZoneOverlay(host, getActiveZoneName(fileResult, zones, 'all'));
    }
  };

  if (video.readyState >= 1 && video.videoWidth) {
    // Layout may not be ready on first paint
    requestAnimationFrame(() => requestAnimationFrame(mount));
  } else {
    video.addEventListener('loadedmetadata', () => {
      requestAnimationFrame(() => requestAnimationFrame(mount));
    }, { once: true });
  }
}

function removeExistingLightbox() {
  const existing = document.querySelector('.lightbox');
  if (existing) {
    if (existing._zoneResize) {
      window.removeEventListener('resize', existing._zoneResize);
    }
    if (existing._playbackTimer) {
      clearInterval(existing._playbackTimer);
    }
    existing.remove();
  }
}

function openLightbox(index) {
  lightboxIndex = index;
  const file = filteredFiles[index];
  if (!file) return;

  if (file.type === 'recording') {
    openRecordingLightbox(index);
    return;
  }

  removeExistingLightbox();

  const src = `${fileApiUrl(file.path || file.name)}`;
  const videoZones = appSettings.videoZones || [];
  const photoZones = appSettings.zones || [];
  const media = file.type === 'video'
    ? `<div class="zone-photo-host lightbox-video-host recording-lightbox-viewport">
        <video src="${src}" controls autoplay></video>
      </div>`
    : `<div class="zone-photo-host lightbox-photo-host">
        <img src="${src}" alt="${file.name}">
        ${renderLightboxRotateToolbar()}
      </div>`;

  const zoneNote = file.type === 'video'
    ? (videoZones.length
      ? `<p class="zone-applied-note">${videoZones.length} video zone(s) apply to this view</p>`
      : '')
    : (photoZones.length
      ? `<p class="zone-applied-note">${photoZones.length} photo zone(s) apply to this view</p>`
      : '');

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.dataset.filename = file.name;
  lb.dataset.filepath = file.path || file.name;
  lb.innerHTML = `
    <div class="lightbox-content">
      <button class="btn btn-ghost lightbox-close" aria-label="Close">✕</button>
      ${filteredFiles.length > 1 ? `
        <button class="btn btn-ghost lightbox-nav prev" aria-label="Previous">←</button>
        <button class="btn btn-ghost lightbox-nav next" aria-label="Next">→</button>
      ` : ''}
      ${media}
      ${zoneNote}
    </div>
    <aside class="lightbox-sidebar glass">
      <div class="lightbox-sidebar-header">
        <h3>${file.name}</h3>
        <p class="lightbox-file-meta">${formatBytes(file.size)} · ${formatDate(file.capturedAt || file.modified)}${file.type === 'video' && file.fps != null ? ` · ${formatFps(file.fps)}` : ''}${file.postprocessedAt ? ` · post ${formatDate(file.postprocessedAt)}` : ''}</p>
        <button type="button" class="btn btn-danger btn-sm lightbox-trash-btn" data-trash-path="${file.path || file.name}" data-trash-label="${file.name.replace(/"/g, '&quot;')}">Move to trash</button>
      </div>
      ${file.type === 'video' ? renderVideoFpsPanel(file, { idPrefix: 'gallery-clip' }) : ''}
      <div class="lightbox-analysis">
        <h4 class="lightbox-analysis-title">AI Analysis</h4>
        <div class="lightbox-analysis-body">
          ${renderResultsPanel(file)}
        </div>
      </div>
    </aside>`;

  document.body.appendChild(lb);

  if (file.type === 'image' && (appSettings.zones || []).length) {
    const drawZones = () => drawLightboxZones(lb);
    const img = lb.querySelector('.lightbox-photo-host img');
    if (img.complete) drawZones();
    else img.addEventListener('load', drawZones);
    window.addEventListener('resize', drawZones, { once: false });
    lb._zoneResize = drawZones;
  }

  if (file.type === 'video' && (appSettings.videoZones || []).length) {
    const drawZones = () => drawLightboxVideoZones(lb, file);
    drawZones();
    window.addEventListener('resize', drawZones, { once: false });
    lb._zoneResize = drawZones;
  }

  bindLightboxInteractions(lb, file);

  if (file.type === 'video') {
    bindVideoFpsPanel(lb, () => file, {
      videoEl: lb.querySelector('video'),
      onUpdated: (result) => {
        const meta = lb.querySelector('.lightbox-file-meta');
        if (meta) {
          const capture = file.capturedAt || file.modified;
          const post = file.postprocessedAt ? ` · post ${formatDate(file.postprocessedAt)}` : '';
          meta.textContent = `${formatBytes(result.size ?? file.size)} · ${formatDate(capture)}${post} · ${formatFps(result.fps)}`;
        }
        if ((appSettings.videoZones || []).length) {
          drawLightboxVideoZones(lb, file);
        }
      },
    });
  }

  lb.querySelector('.lightbox-trash-btn')?.addEventListener('click', () => {
    trashItem(file.path || file.name, file.name);
  });

  bindLightboxRotateButtons(lb, file);

  lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lb.querySelector('.lightbox-nav.prev')?.addEventListener('click', () => navigateLightbox(-1));
  lb.querySelector('.lightbox-nav.next')?.addEventListener('click', () => navigateLightbox(1));
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

  document.addEventListener('keydown', handleLightboxKey);
}

function openVideoRecordingLightbox(index) {
  lightboxIndex = index;
  const file = filteredFiles[index];
  const videos = file?.videos || [];
  if (!videos.length) return;

  removeExistingLightbox();

  let clipIndex = 0;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.dataset.filename = file.name;
  lb.dataset.filepath = file.path || file.name;
  lb.innerHTML = `
    <div class="lightbox-content">
      <button class="btn btn-ghost lightbox-close" aria-label="Close">✕</button>
      ${filteredFiles.length > 1 ? `
        <button class="btn btn-ghost lightbox-nav prev" aria-label="Previous">←</button>
        <button class="btn btn-ghost lightbox-nav next" aria-label="Next">→</button>
      ` : ''}
      <div class="recording-player">
        <div class="recording-playback-viewport recording-lightbox-viewport">
          <video class="recording-video-player rp-video" controls autoplay src="${fileApiUrl(videos[0].path)}"></video>
        </div>
        ${(appSettings.videoZones || []).length
    ? `<p class="zone-applied-note">${appSettings.videoZones.length} video zone(s) apply to this view</p>`
    : ''}
        <div class="recording-playback-controls">
          <button type="button" class="btn btn-ghost btn-sm rp-prev" ${videos.length < 2 ? 'disabled' : ''}>‹ Prev clip</button>
          <span class="recording-playback-counter rp-counter">1 / ${videos.length}</span>
          <button type="button" class="btn btn-ghost btn-sm rp-next" ${videos.length < 2 ? 'disabled' : ''}>Next clip ›</button>
        </div>
      </div>
    </div>
    <aside class="lightbox-sidebar glass">
      <div class="lightbox-sidebar-header">
        <h3>${file.name}</h3>
        <p class="lightbox-file-meta lightbox-recording-meta">${videos.length} video clip${videos.length === 1 ? '' : 's'} · ${formatBytes(file.size)} · ${formatDate(file.modified)}</p>
        <div class="lightbox-trash-actions">
          <a class="btn btn-ghost btn-sm rp-download" href="${fileApiUrl(videos[0].path)}" download="${videos[0].name}">Download clip</a>
          <button type="button" class="btn btn-danger btn-sm lightbox-trash-recording-btn" data-trash-path="${file.path}" data-trash-label="${file.name.replace(/"/g, '&quot;')}">Delete entire recording</button>
        </div>
      </div>
      ${renderVideoFpsPanel(videos[0], { idPrefix: 'gallery-rec-clip' })}
      <div class="lightbox-analysis">
        <h4>Clips</h4>
        <ul class="recording-video-list">
          ${videos.map((v, i) => `
            <li>
              <button type="button" class="btn btn-ghost btn-sm recording-video-pick" data-clip-index="${i}">
                ${formatClipPickLabel(v, i)}
              </button>
            </li>`).join('')}
        </ul>
      </div>
    </aside>`;

  document.body.appendChild(lb);

  // Prefer a live query each time — do not keep a stale node if DOM shifted.
  const getVideoEl = () => lb.querySelector('.rp-video') || lb.querySelector('video');
  const counter = lb.querySelector('.rp-counter');
  const downloadLink = lb.querySelector('.rp-download');
  const fpsPanel = lb.querySelector('.gallery-video-fps-panel');

  function remountVideoZones() {
    if (!(appSettings.videoZones || []).length) return;
    lb._analysisFile = videos[clipIndex];
    drawLightboxVideoZones(lb, videos[clipIndex]);
  }

  function showClip(i) {
    clipIndex = Math.max(0, Math.min(i, videos.length - 1));
    const clip = videos[clipIndex];
    const videoEl = getVideoEl();
    if (!videoEl) return;

    videoEl.src = `${fileApiUrl(clip.path)}`;
    counter.textContent = `${clipIndex + 1} / ${videos.length}`;
    if (downloadLink) {
      downloadLink.href = fileApiUrl(clip.path);
      downloadLink.setAttribute('download', clip.name);
    }
    refreshVideoFpsPanel(fpsPanel, clip);
    remountVideoZones();
    videoEl.play?.().catch(() => {});
  }

  remountVideoZones();
  window.addEventListener('resize', remountVideoZones, { once: false });
  lb._zoneResize = remountVideoZones;

  lb.querySelector('.rp-prev')?.addEventListener('click', () => showClip(clipIndex - 1));
  lb.querySelector('.rp-next')?.addEventListener('click', () => showClip(clipIndex + 1));
  lb.querySelectorAll('.recording-video-pick').forEach((btn) => {
    btn.addEventListener('click', () => showClip(Number(btn.dataset.clipIndex) || 0));
  });

  bindVideoFpsPanel(lb, () => videos[clipIndex], {
    // Always resolve the live <video> — clip switching reuses the same node.
    getVideoEl,
    onUpdated: (result) => {
      const pickBtns = lb.querySelectorAll('.recording-video-pick');
      const btn = pickBtns[clipIndex];
      if (btn) {
        const clip = videos[clipIndex];
        btn.textContent = formatClipPickLabel(clip, clipIndex);
      }
      // Keep recording card size in sync after a clip shrinks.
      if (result?.size != null) {
        file.size = videos.reduce((sum, v) => sum + (v.size || 0), 0);
      }
      const meta = lb.querySelector('.lightbox-recording-meta');
      if (meta) {
        meta.textContent = `${videos.length} video clip${videos.length === 1 ? '' : 's'} · ${formatBytes(file.size)} · ${formatDate(file.modified)}`;
      }
      remountVideoZones();
    },
  });

  lb.querySelector('.lightbox-trash-recording-btn')?.addEventListener('click', () => {
    trashItem(file.path, file.name);
  });

  lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lb.querySelector('.lightbox-nav.prev')?.addEventListener('click', () => navigateLightbox(-1));
  lb.querySelector('.lightbox-nav.next')?.addEventListener('click', () => navigateLightbox(1));
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', handleLightboxKey);
}

function openRecordingLightbox(index) {
  lightboxIndex = index;
  const file = filteredFiles[index];
  if (!file) return;

  const isVideoRec = file.mode === 'video' || (!file.frames?.length && file.videos?.length);
  if (isVideoRec) {
    openVideoRecordingLightbox(index);
    return;
  }

  if (!file.frames?.length) return;

  removeExistingLightbox();

  const frames = file.frames;
  let frameIndex = 0;
  let playing = false;
  let fps = 5;

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.dataset.filename = file.name;
  lb.dataset.filepath = file.path || file.name;
  lb.innerHTML = `
    <div class="lightbox-content">
      <button class="btn btn-ghost lightbox-close" aria-label="Close">✕</button>
      ${filteredFiles.length > 1 ? `
        <button class="btn btn-ghost lightbox-nav prev" aria-label="Previous">←</button>
        <button class="btn btn-ghost lightbox-nav next" aria-label="Next">→</button>
      ` : ''}
      <div class="recording-player">
        <div class="recording-playback-viewport recording-lightbox-viewport">
          <img class="recording-playback-frame rp-frame" alt="">
          ${renderLightboxRotateToolbar()}
        </div>
        <input type="range" class="recording-scrubber rp-scrubber" min="0" max="${frames.length - 1}" value="0" step="1" aria-label="Playback position">
        <div class="recording-playback-controls">
          <button type="button" class="btn btn-ghost btn-sm rp-prev">‹ Prev</button>
          <button type="button" class="btn btn-primary btn-sm rp-playpause">Play</button>
          <button type="button" class="btn btn-ghost btn-sm rp-next">Next ›</button>
          <span class="recording-playback-counter rp-counter">1 / ${frames.length}</span>
          <label class="recording-speed">
            <span>Speed</span>
            <select class="rp-speed">
              <option value="1">1 fps</option>
              <option value="2">2 fps</option>
              <option value="5" selected>5 fps</option>
              <option value="10">10 fps</option>
              <option value="20">20 fps</option>
            </select>
          </label>
        </div>
      </div>
    </div>
    <aside class="lightbox-sidebar glass">
      <div class="lightbox-sidebar-header">
        <h3>${file.name}</h3>
        <p class="lightbox-file-meta">${file.frameCount} frames · ${formatBytes(file.size)} · ${formatDate(file.modified)}</p>
        <div class="lightbox-trash-actions">
          <button type="button" class="btn btn-danger btn-sm lightbox-trash-frame-btn">Delete current frame</button>
          <button type="button" class="btn btn-danger btn-sm lightbox-trash-recording-btn" data-trash-path="${file.path}" data-trash-label="${file.name.replace(/"/g, '&quot;')}">Delete entire recording</button>
        </div>
      </div>
      <div class="lightbox-analysis recording-current-analysis">
        <h4 class="lightbox-analysis-title">AI Analysis</h4>
        <p class="recording-current-frame-name" id="recording-current-frame-name"></p>
        <div class="lightbox-analysis-body recording-current-analysis-body"></div>
      </div>
      <div class="lightbox-analysis recording-frames-analysis">
        <h4 class="lightbox-analysis-title">All frames</h4>
        ${renderRecordingFrameList(frames, 0)}
      </div>
    </aside>`;

  document.body.appendChild(lb);

  const img = lb.querySelector('.rp-frame');
  const scrubber = lb.querySelector('.rp-scrubber');
  const counter = lb.querySelector('.rp-counter');
  const playPause = lb.querySelector('.rp-playpause');

  const frameMs = () => Math.max(50, Math.round(1000 / fps));

  function showFrame() {
    frameIndex = Math.max(0, Math.min(frameIndex, frames.length - 1));
    img.src = `${fileApiUrl(frames[frameIndex].path)}`;
    img.alt = `Frame ${frameIndex + 1}: ${frames[frameIndex].name}`;
    counter.textContent = `${frameIndex + 1} / ${frames.length}`;
    scrubber.value = String(frameIndex);
    playPause.textContent = playing ? 'Pause' : 'Play';
    syncRecordingFrameListActive(lb, frameIndex);
    updateRecordingFrameAnalysis(lb, frames[frameIndex]);
  }

  function refreshFrameList() {
    const list = lb.querySelector('#recording-frame-list');
    if (!list) return;
    list.outerHTML = renderRecordingFrameList(frames, frameIndex);
    bindRecordingFrameList(lb, frames, (index) => {
      stop();
      frameIndex = index;
      showFrame();
    });
  }

  function stop() {
    playing = false;
    if (lb._playbackTimer) {
      clearInterval(lb._playbackTimer);
      lb._playbackTimer = null;
    }
    playPause.textContent = 'Play';
  }

  function step() {
    if (frameIndex < frames.length - 1) {
      frameIndex += 1;
      showFrame();
    } else {
      stop();
    }
  }

  function play() {
    if (frameIndex >= frames.length - 1) frameIndex = 0;
    playing = true;
    if (lb._playbackTimer) clearInterval(lb._playbackTimer);
    lb._playbackTimer = setInterval(step, frameMs());
    showFrame();
  }

  playPause.addEventListener('click', () => {
    if (playing) stop();
    else play();
  });
  lb.querySelector('.rp-prev').addEventListener('click', () => {
    stop();
    if (frameIndex > 0) {
      frameIndex -= 1;
      showFrame();
    }
  });
  lb.querySelector('.rp-next').addEventListener('click', () => {
    stop();
    if (frameIndex < frames.length - 1) {
      frameIndex += 1;
      showFrame();
    }
  });
  scrubber.addEventListener('input', (e) => {
    stop();
    frameIndex = Number(e.target.value) || 0;
    showFrame();
  });
  lb.querySelector('.rp-speed').addEventListener('change', (e) => {
    fps = Number(e.target.value) || 5;
    if (playing) play();
  });

  showFrame();

  bindRecordingFrameList(lb, frames, (index) => {
    stop();
    frameIndex = index;
    showFrame();
  });

  bindLightboxInteractions(lb, frames[0]);

  bindLightboxRotateButtons(lb, null, () => frames[frameIndex]);

  lb.querySelector('.lightbox-trash-frame-btn')?.addEventListener('click', async () => {
    const frame = frames[frameIndex];
    if (!frame) return;
    const ok = await trashItem(frame.path, frame.name, { closeOnSuccess: false });
    if (!ok) return;

    const entry = allFiles.find((f) => f.type === 'recording' && f.path === file.path);
    if (entry) {
      frames.length = 0;
      frames.push(...entry.frames);
    }

    if (!frames.length) {
      closeLightbox();
      return;
    }

    if (frameIndex >= frames.length) frameIndex = frames.length - 1;
    scrubber.max = String(frames.length - 1);
    file.frames = frames;
    file.frameCount = frames.length;
    file.size = frames.reduce((sum, fr) => sum + (fr.size || 0), 0);
    counter.textContent = `${frameIndex + 1} / ${frames.length}`;
    lb.querySelector('.lightbox-file-meta').textContent =
      `${file.frameCount} frames · ${formatBytes(file.size)} · ${formatDate(file.modified)}`;
    refreshFrameList();
    showFrame();
  });

  lb.querySelector('.lightbox-trash-recording-btn')?.addEventListener('click', () => {
    trashItem(file.path, file.name);
  });

  lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lb.querySelector('.lightbox-nav.prev')?.addEventListener('click', () => navigateLightbox(-1));
  lb.querySelector('.lightbox-nav.next')?.addEventListener('click', () => navigateLightbox(1));
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

  document.addEventListener('keydown', handleLightboxKey);
}

function closeLightbox() {
  const lb = document.querySelector('.lightbox');
  if (lb?._zoneResize) {
    window.removeEventListener('resize', lb._zoneResize);
  }
  if (lb?._playbackTimer) {
    clearInterval(lb._playbackTimer);
  }
  lb?.remove();
  document.removeEventListener('keydown', handleLightboxKey);
  lightboxIndex = -1;
}

function navigateLightbox(dir) {
  const newIndex = lightboxIndex + dir;
  if (newIndex >= 0 && newIndex < filteredFiles.length) {
    openLightbox(newIndex);
  }
}

function handleLightboxKey(e) {
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') navigateLightbox(-1);
  if (e.key === 'ArrowRight') navigateLightbox(1);
}

function bindFilters() {
  document.getElementById('gallery-search')?.addEventListener('input', applyFilters);
  document.getElementById('gallery-date-from')?.addEventListener('change', applyFilters);
  document.getElementById('gallery-date-to')?.addEventListener('change', applyFilters);

  document.querySelectorAll('#gallery-type-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#gallery-type-toggle button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    });
  });
}

async function loadData() {
  renderSkeleton();
  try {
    const [files, res, settings] = await Promise.all([
      apiFetch('/api/files'),
      apiFetch('/api/results'),
      apiFetch('/api/settings'),
    ]);
    allFiles = groupFiles(files);
    results = res;
    appSettings = settings;
    filteredFiles = [...allFiles];

    container().innerHTML = `
      ${renderFilters()}
      <div class="gallery-grid" id="gallery-grid"></div>`;

    bindFilters();
    renderGrid();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <h3>Failed to load gallery</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function init() {
  loadData();
}

export function refresh() {
  loadData();
}
