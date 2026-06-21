import { apiFetch, formatBytes, formatDate, showToast } from './utils.js';

let allFiles = [];
let filteredFiles = [];
let results = {};
let lightboxIndex = -1;

const container = () => document.getElementById('gallery-content');

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
    if (typeFilter !== 'all' && f.type !== typeFilter) return false;

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

function renderResultsPanel(file) {
  const result = results[file.name];
  if (!result) {
    return '<p>No AI results yet. Process this file in the Processing tab.</p>';
  }

  let html = `<p><strong>Processed:</strong> ${formatDate(result.processedAt)}</p>`;

  if (result.zones) {
    html += result.zones.map((zone) => `
      <div style="margin-top: 0.75rem;">
        <strong>${zone.name}</strong>
        <ul style="margin-top: 0.25rem; padding-left: 1.25rem; font-size: 0.875rem;">
          ${(zone.foods || []).map((f) => `
            <li>${f.item} (${f.portion}) — ${(f.ingredients || []).join(', ')}</li>
          `).join('')}
        </ul>
      </div>
    `).join('');
  }

  return html;
}

function openLightbox(index) {
  lightboxIndex = index;
  const file = filteredFiles[index];
  if (!file) return;

  const existing = document.querySelector('.lightbox');
  if (existing) existing.remove();

  const src = `/api/file/${encodeURIComponent(file.path || file.name)}`;
  const media = file.type === 'video'
    ? `<video src="${src}" controls autoplay></video>`
    : `<img src="${src}" alt="${file.name}">`;

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `
    <div class="lightbox-content">
      <button class="btn btn-ghost lightbox-close" aria-label="Close">✕</button>
      ${filteredFiles.length > 1 ? `
        <button class="btn btn-ghost lightbox-nav prev" aria-label="Previous">←</button>
        <button class="btn btn-ghost lightbox-nav next" aria-label="Next">→</button>
      ` : ''}
      ${media}
    </div>
    <aside class="lightbox-sidebar glass">
      <h3>${file.name}</h3>
      <p style="margin: 0.5rem 0; font-size: 0.875rem;">${formatBytes(file.size)} · ${formatDate(file.modified)}</p>
      <hr style="border: none; border-top: 1px solid var(--color-border); margin: 1rem 0;">
      <h4 style="margin-bottom: 0.5rem;">AI Results</h4>
      ${renderResultsPanel(file)}
    </aside>`;

  document.body.appendChild(lb);
  lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lb.querySelector('.lightbox-nav.prev')?.addEventListener('click', () => navigateLightbox(-1));
  lb.querySelector('.lightbox-nav.next')?.addEventListener('click', () => navigateLightbox(1));
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

  document.addEventListener('keydown', handleLightboxKey);
}

function closeLightbox() {
  document.querySelector('.lightbox')?.remove();
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
    const [files, res] = await Promise.all([
      apiFetch('/api/files'),
      apiFetch('/api/results'),
    ]);
    allFiles = files;
    results = res;
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
