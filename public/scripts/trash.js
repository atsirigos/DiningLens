import { apiFetch, formatBytes, formatDate, showToast } from './utils.js';
import { groupFiles } from './gallery.js';

let allFiles = [];
let filteredFiles = [];
let lightboxIndex = -1;

const container = () => document.getElementById('trash-content');

function fileUrl(filePath) {
  return `/api/trash/file/${encodeURIComponent(filePath)}`;
}

function renderSkeleton() {
  container().innerHTML = `
    <div class="gallery-grid">
      ${Array(6).fill('<div class="skeleton skeleton-card"></div>').join('')}
    </div>`;
}

function renderToolbar() {
  const hasItems = allFiles.length > 0;
  return `
    <div class="trash-toolbar glass" style="padding: 1rem; margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
      <p class="trash-toolbar-note" style="margin: 0; color: var(--color-text-muted); font-size: 0.875rem;">
        ${hasItems ? `${allFiles.length} item${allFiles.length === 1 ? '' : 's'} in trash` : 'Trash is empty'}
      </p>
      <button type="button" class="btn btn-danger btn-sm" id="trash-empty-btn" ${hasItems ? '' : 'disabled'}>Empty trash</button>
    </div>`;
}

async function restoreItem(itemPath, label) {
  try {
    await apiFetch('/api/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: itemPath }),
    });
    showToast(`Restored: ${label}`, 'success');
    closeLightbox();
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deletePermanent(itemPath, label) {
  if (!window.confirm(`Permanently delete "${label}"? This cannot be undone.`)) return;

  try {
    await apiFetch(`/api/trash/${encodeURIComponent(itemPath)}`, { method: 'DELETE' });
    showToast(`Permanently deleted: ${label}`, 'info');
    closeLightbox();
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function emptyTrash() {
  if (!window.confirm('Permanently delete all items in trash? This cannot be undone.')) return;

  try {
    await apiFetch('/api/trash', { method: 'DELETE' });
    showToast('Trash emptied', 'info');
    closeLightbox();
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderGrid() {
  const grid = document.getElementById('trash-grid');
  if (!grid) return;

  if (filteredFiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <div class="empty-state-icon">🗑️</div>
        <h3>Trash is empty</h3>
        <p>Deleted gallery items will appear here.</p>
      </div>`;
    return;
  }

  grid.innerHTML = filteredFiles.map((file, idx) => {
    if (file.type === 'recording') {
      const isVideoRec = file.mode === 'video' || (!file.frames?.length && file.videos?.length);
      const thumbSrc = file.frames?.[0]
        ? fileUrl(file.frames[0].path)
        : (file.videos?.[0]?.thumbPath ? fileUrl(file.videos[0].thumbPath) : '');
      const badge = isVideoRec
        ? `🎥 ${file.videos?.length || 0} clip${(file.videos?.length || 0) === 1 ? '' : 's'}`
        : `🎬 ${file.frameCount} frame${file.frameCount === 1 ? '' : 's'}`;
      return `
        <div class="card gallery-card" data-index="${idx}" tabindex="0" role="button" aria-label="View ${file.name}">
          <div class="gallery-card-actions">
            <button type="button" class="btn btn-ghost btn-sm trash-restore-btn" data-path="${file.path}" data-label="${file.name.replace(/"/g, '&quot;')}" title="Restore">↩</button>
            <button type="button" class="btn btn-ghost btn-sm trash-delete-btn" data-path="${file.path}" data-label="${file.name.replace(/"/g, '&quot;')}" title="Delete permanently">✕</button>
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
            </div>
          </div>
        </div>`;
    }

    const thumbSrc = file.type === 'image'
      ? fileUrl(file.path || file.name)
      : (file.thumbPath ? fileUrl(file.thumbPath) : '');

    return `
      <div class="card gallery-card" data-index="${idx}" tabindex="0" role="button" aria-label="View ${file.name}">
        <div class="gallery-card-actions">
          <button type="button" class="btn btn-ghost btn-sm trash-restore-btn" data-path="${file.path || file.name}" data-label="${file.name.replace(/"/g, '&quot;')}" title="Restore">↩</button>
          <button type="button" class="btn btn-ghost btn-sm trash-delete-btn" data-path="${file.path || file.name}" data-label="${file.name.replace(/"/g, '&quot;')}" title="Delete permanently">✕</button>
        </div>
        ${thumbSrc
          ? `<img class="gallery-card-thumb" src="${thumbSrc}" alt="${file.name}" loading="lazy">`
          : `<div class="gallery-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:2rem;">🎬</div>`}
        <div class="gallery-card-body">
          <div class="gallery-card-name" title="${file.name}">${file.name}</div>
          <div class="gallery-card-meta">
            <span>${formatBytes(file.size)}</span>
            <span>${formatDate(file.modified)}</span>
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

  grid.querySelectorAll('.trash-restore-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreItem(btn.dataset.path, btn.dataset.label);
    });
  });

  grid.querySelectorAll('.trash-delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePermanent(btn.dataset.path, btn.dataset.label);
    });
  });
}

function removeExistingLightbox() {
  const existing = document.querySelector('.lightbox');
  if (existing?._playbackTimer) clearInterval(existing._playbackTimer);
  existing?.remove();
}

function closeLightbox() {
  const lb = document.querySelector('.lightbox');
  if (lb?._playbackTimer) clearInterval(lb._playbackTimer);
  lb?.remove();
  document.removeEventListener('keydown', handleLightboxKey);
  lightboxIndex = -1;
}

function openLightbox(index) {
  lightboxIndex = index;
  const file = filteredFiles[index];
  if (!file) return;

  if (file.type === 'recording') {
    openRecordingLightbox(file);
    return;
  }

  removeExistingLightbox();

  const src = fileUrl(file.path || file.name);
  const media = file.type === 'video'
    ? `<video src="${src}" controls autoplay></video>`
    : `<img src="${src}" alt="${file.name}">`;

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `
    <div class="lightbox-content">
      <button class="btn btn-ghost lightbox-close" aria-label="Close">✕</button>
      ${media}
    </div>
    <aside class="lightbox-sidebar glass">
      <div class="lightbox-sidebar-header">
        <h3>${file.name}</h3>
        <p class="lightbox-file-meta">${formatBytes(file.size)} · ${formatDate(file.modified)}</p>
        <div class="lightbox-trash-actions">
          <button type="button" class="btn btn-primary btn-sm trash-restore-btn" data-path="${file.path || file.name}" data-label="${file.name.replace(/"/g, '&quot;')}">Restore</button>
          <button type="button" class="btn btn-danger btn-sm trash-delete-btn" data-path="${file.path || file.name}" data-label="${file.name.replace(/"/g, '&quot;')}">Delete permanently</button>
        </div>
      </div>
    </aside>`;

  document.body.appendChild(lb);
  bindLightboxActions(lb);
}

function openRecordingLightbox(file) {
  if (!file?.frames?.length) return;

  removeExistingLightbox();

  const frames = file.frames;
  let frameIndex = 0;
  let playing = false;
  let fps = 5;

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `
    <div class="lightbox-content">
      <button class="btn btn-ghost lightbox-close" aria-label="Close">✕</button>
      <div class="recording-player">
        <div class="recording-playback-viewport">
          <img class="recording-playback-frame rp-frame" alt="">
        </div>
        <input type="range" class="recording-scrubber rp-scrubber" min="0" max="${frames.length - 1}" value="0" step="1" aria-label="Playback position">
        <div class="recording-playback-controls">
          <button type="button" class="btn btn-ghost btn-sm rp-prev">‹ Prev</button>
          <button type="button" class="btn btn-primary btn-sm rp-playpause">Play</button>
          <button type="button" class="btn btn-ghost btn-sm rp-next">Next ›</button>
          <span class="recording-playback-counter rp-counter">1 / ${frames.length}</span>
        </div>
      </div>
    </div>
    <aside class="lightbox-sidebar glass">
      <div class="lightbox-sidebar-header">
        <h3>${file.name}</h3>
        <p class="lightbox-file-meta">${file.frameCount} frames · ${formatBytes(file.size)}</p>
        <div class="lightbox-trash-actions">
          <button type="button" class="btn btn-primary btn-sm trash-restore-btn" data-path="${file.path}" data-label="${file.name.replace(/"/g, '&quot;')}">Restore recording</button>
          <button type="button" class="btn btn-danger btn-sm trash-delete-btn" data-path="${file.path}" data-label="${file.name.replace(/"/g, '&quot;')}">Delete permanently</button>
        </div>
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
    img.src = fileUrl(frames[frameIndex].path);
    counter.textContent = `${frameIndex + 1} / ${frames.length}`;
    scrubber.value = String(frameIndex);
    playPause.textContent = playing ? 'Pause' : 'Play';
  }

  function stop() {
    playing = false;
    if (lb._playbackTimer) {
      clearInterval(lb._playbackTimer);
      lb._playbackTimer = null;
    }
    playPause.textContent = 'Play';
  }

  playPause.addEventListener('click', () => {
    if (playing) stop();
    else {
      if (frameIndex >= frames.length - 1) frameIndex = 0;
      playing = true;
      lb._playbackTimer = setInterval(() => {
        if (frameIndex < frames.length - 1) {
          frameIndex += 1;
          showFrame();
        } else stop();
      }, frameMs());
      showFrame();
    }
  });

  lb.querySelector('.rp-prev').addEventListener('click', () => {
    stop();
    if (frameIndex > 0) { frameIndex -= 1; showFrame(); }
  });
  lb.querySelector('.rp-next').addEventListener('click', () => {
    stop();
    if (frameIndex < frames.length - 1) { frameIndex += 1; showFrame(); }
  });
  scrubber.addEventListener('input', (e) => {
    stop();
    frameIndex = Number(e.target.value) || 0;
    showFrame();
  });

  showFrame();
  bindLightboxActions(lb);
}

function bindLightboxActions(lb) {
  lb.querySelector('.lightbox-close')?.addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', handleLightboxKey);

  lb.querySelectorAll('.trash-restore-btn').forEach((btn) => {
    btn.addEventListener('click', () => restoreItem(btn.dataset.path, btn.dataset.label));
  });
  lb.querySelectorAll('.trash-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deletePermanent(btn.dataset.path, btn.dataset.label));
  });
}

function handleLightboxKey(e) {
  if (e.key === 'Escape') closeLightbox();
}

async function loadData() {
  renderSkeleton();
  try {
    const files = await apiFetch('/api/trash');
    allFiles = groupFiles(files);
    filteredFiles = [...allFiles];

    container().innerHTML = `
      ${renderToolbar()}
      <div class="gallery-grid" id="trash-grid"></div>`;

    document.getElementById('trash-empty-btn')?.addEventListener('click', emptyTrash);
    renderGrid();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <h3>Failed to load trash</h3>
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
