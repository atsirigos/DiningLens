import { apiFetch, formatBytes, formatDate, showToast } from './utils.js';
import {
  getActiveZoneName,
  renderGalleryAnalysisPanel,
} from './mealResults.js';
import { mountZoneOverlay, highlightZoneOverlay } from './zoneOverlay.js';

let allFiles = [];
let filteredFiles = [];
let results = {};
let appSettings = { zones: [] };
let lightboxIndex = -1;

const container = () => document.getElementById('gallery-content');

function groupFiles(files) {
  const sessions = new Map();
  const others = [];

  for (const f of files) {
    const parts = (f.path || f.name).split('/');
    if (parts[0] === 'recordings' && parts.length >= 3 && f.type === 'image') {
      const session = parts[1];
      if (!sessions.has(session)) sessions.set(session, []);
      sessions.get(session).push(f);
    } else {
      others.push(f);
    }
  }

  const recordingEntries = [];
  for (const [session, frames] of sessions) {
    frames.sort((a, b) => new Date(a.modified) - new Date(b.modified) || a.name.localeCompare(b.name));
    const totalSize = frames.reduce((sum, fr) => sum + (fr.size || 0), 0);
    recordingEntries.push({
      type: 'recording',
      session,
      name: `Recording ${session}`,
      path: `recordings/${session}`,
      frames,
      frameCount: frames.length,
      size: totalSize,
      modified: frames[frames.length - 1]?.modified || new Date().toISOString(),
    });
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
  const search = document.getElementById('gallery-search')?.value.toLowerCase() || '';
  const dateFrom = document.getElementById('gallery-date-from')?.value;
  const dateTo = document.getElementById('gallery-date-to')?.value;
  const typeBtn = document.querySelector('#gallery-type-toggle button.active');
  const typeFilter = typeBtn?.dataset.type || 'all';

  filteredFiles = allFiles.filter((f) => {
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
      const thumbSrc = file.frames[0]
        ? `/api/file/${encodeURIComponent(file.frames[0].path)}`
        : '';
      return `
        <div class="card gallery-card" data-index="${idx}" tabindex="0" role="button" aria-label="Play ${file.name}">
          <div class="gallery-card-thumb gallery-recording-thumb">
            ${thumbSrc ? `<img src="${thumbSrc}" alt="${file.name}" loading="lazy">` : ''}
            <span class="gallery-recording-play" aria-hidden="true">▶</span>
            <span class="gallery-recording-badge">🎬 ${file.frameCount} frame${file.frameCount === 1 ? '' : 's'}</span>
          </div>
          <div class="gallery-card-body">
            <div class="gallery-card-name" title="${file.name}">${file.name}</div>
            <div class="gallery-card-meta">
              <span>${formatBytes(file.size)}</span>
              <span class="badge badge-muted">Recording</span>
            </div>
          </div>
        </div>`;
    }

    const isProcessed = !!results[file.name];
    const thumbSrc = file.type === 'image'
      ? `/api/file/${encodeURIComponent(file.path || file.name)}`
      : '';

    return `
      <div class="card gallery-card" data-index="${idx}" tabindex="0" role="button" aria-label="View ${file.name}">
        ${file.type === 'image'
          ? `<img class="gallery-card-thumb" src="${thumbSrc}" alt="${file.name}" loading="lazy">`
          : `<div class="gallery-card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:2rem;">🎬</div>`}
        <div class="gallery-card-body">
          <div class="gallery-card-name" title="${file.name}">${file.name}</div>
          <div class="gallery-card-meta">
            <span>${formatBytes(file.size)}</span>
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
}

function renderResultsPanel(file, activeTabId = 'all') {
  const result = results[file.name];
  if (!result) {
    return '<p>No AI results yet. Process this file in the Processing tab.</p>';
  }

  let html = `<p class="analysis-processed-at"><strong>Processed:</strong> ${formatDate(result.processedAt)}</p>`;
  html += renderGalleryAnalysisPanel(result, appSettings.zones, activeTabId, file);
  return html;
}

function bindAnalysisTabs(lightbox, file) {
  const result = results[file.name];
  if (!result) return;

  const analysisBody = lightbox.querySelector('.lightbox-analysis-body');
  if (!analysisBody) return;

  analysisBody.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-zone-tab]');
    if (!tab || !analysisBody.contains(tab)) return;

    const activeTabId = tab.dataset.zoneTab;
    analysisBody.innerHTML = renderResultsPanel(file, activeTabId);

    const highlightZone = getActiveZoneName(result, appSettings.zones, activeTabId);
    highlightZoneOverlay(lightbox.querySelector('.lightbox-photo-host'), highlightZone);
  });
}

function drawLightboxZones(lightbox) {
  const img = lightbox.querySelector('.lightbox-photo-host img');
  const host = lightbox.querySelector('.lightbox-photo-host');
  if (!host || !img || !appSettings.zones?.length) return;

  mountZoneOverlay(host, img, appSettings.zones);
  const result = results[lightbox.dataset.filename];
  if (result) {
    highlightZoneOverlay(host, getActiveZoneName(result, appSettings.zones, 'all'));
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

  const src = `/api/file/${encodeURIComponent(file.path || file.name)}`;
  const media = file.type === 'video'
    ? `<video src="${src}" controls autoplay></video>`
    : `<div class="zone-photo-host lightbox-photo-host"><img src="${src}" alt="${file.name}"></div>`;

  const zoneNote = appSettings.zones?.length
    ? `<p class="zone-applied-note">${appSettings.zones.length} saved zone(s) apply to this view</p>`
    : '';

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.dataset.filename = file.name;
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
        <p class="lightbox-file-meta">${formatBytes(file.size)} · ${formatDate(file.modified)}</p>
      </div>
      <div class="lightbox-analysis">
        <h4 class="lightbox-analysis-title">AI Analysis</h4>
        <div class="lightbox-analysis-body">
          ${renderResultsPanel(file)}
        </div>
      </div>
    </aside>`;

  document.body.appendChild(lb);

  if (file.type === 'image' && appSettings.zones?.length) {
    const drawZones = () => drawLightboxZones(lb);
    const img = lb.querySelector('.lightbox-photo-host img');
    if (img.complete) drawZones();
    else img.addEventListener('load', drawZones);
    window.addEventListener('resize', drawZones, { once: false });
    lb._zoneResize = drawZones;
  }

  bindAnalysisTabs(lb, file);

  lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lb.querySelector('.lightbox-nav.prev')?.addEventListener('click', () => navigateLightbox(-1));
  lb.querySelector('.lightbox-nav.next')?.addEventListener('click', () => navigateLightbox(1));
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

  document.addEventListener('keydown', handleLightboxKey);
}

function openRecordingLightbox(index) {
  lightboxIndex = index;
  const file = filteredFiles[index];
  if (!file?.frames?.length) return;

  removeExistingLightbox();

  const frames = file.frames;
  let frameIndex = 0;
  let playing = false;
  let fps = 5;

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.dataset.filename = file.name;
  lb.innerHTML = `
    <div class="lightbox-content">
      <button class="btn btn-ghost lightbox-close" aria-label="Close">✕</button>
      ${filteredFiles.length > 1 ? `
        <button class="btn btn-ghost lightbox-nav prev" aria-label="Previous">←</button>
        <button class="btn btn-ghost lightbox-nav next" aria-label="Next">→</button>
      ` : ''}
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
      </div>
      <div class="lightbox-analysis">
        <p class="recording-lightbox-note">
          Frames are stored in <code>data/${file.path}/</code>. Use the controls to play the captured sequence back as a hyperlapse.
        </p>
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
    img.src = `/api/file/${encodeURIComponent(frames[frameIndex].path)}`;
    img.alt = `Frame ${frameIndex + 1}: ${frames[frameIndex].name}`;
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
