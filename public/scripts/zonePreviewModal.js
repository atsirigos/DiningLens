import { mountZoneOverlay } from './zoneOverlay.js';
import { cropZoneToDataUrl } from './zoneGeometry.js';

function removeModal(modal) {
  if (modal?._onResize) {
    window.removeEventListener('resize', modal._onResize);
  }
  modal?.remove();
}

function renderZoneCrops(host, img, zones) {
  if (!host || !img?.naturalWidth) return;

  host.innerHTML = zones.map((zone) => {
    const src = cropZoneToDataUrl(img, zone);
    return `
      <figure class="analysis-zone-crop">
        <img src="${src}" alt="Crop: ${zone.name}" loading="eager">
        <figcaption>${zone.name}</figcaption>
      </figure>`;
  }).join('');
}

/**
 * Show a confirmation modal with the full photo (zone overlays) and per-zone crops.
 * Crops are rendered client-side with the same transform as the Zones editor.
 * Resolves true if the user confirms, false if they cancel.
 */
export function confirmZoneProcessing({ filename, filePath, zones }) {
  if (!zones?.length) return Promise.resolve(true);

  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'zone-preview-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'zone-preview-title');

    const src = `/api/file/${encodeURIComponent(filePath || filename)}`;

    modal.innerHTML = `
      <div class="zone-preview-backdrop" data-action="cancel"></div>
      <div class="zone-preview-dialog glass">
        <div class="zone-preview-header">
          <h3 id="zone-preview-title">Confirm zone crops</h3>
          <p class="zone-preview-subtitle">
            Review how <strong>${filename}</strong> will be split before sending to the AI.
            Each crop below is analyzed in a separate API call.
          </p>
        </div>
        <div class="zone-preview-body">
          <section class="zone-preview-section">
            <h4>Full photo with zones</h4>
            <div class="zone-photo-host zone-preview-photo-host">
              <img src="${src}" alt="${filename}">
            </div>
          </section>
          <section class="zone-preview-section">
            <h4>Zone crops (${zones.length})</h4>
            <div class="zone-preview-crops-grid" id="zone-preview-crops"></div>
          </section>
        </div>
        <div class="zone-preview-actions">
          <button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-action="confirm">Confirm &amp; Process</button>
        </div>
      </div>`;

    const finish = (confirmed) => {
      removeModal(modal);
      document.removeEventListener('keydown', onKeyDown);
      resolve(confirmed);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') finish(false);
    };

    modal.querySelector('[data-action="confirm"]')?.addEventListener('click', () => finish(true));
    modal.querySelectorAll('[data-action="cancel"]').forEach((el) => {
      el.addEventListener('click', () => finish(false));
    });

    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(modal);

    const host = modal.querySelector('.zone-preview-photo-host');
    const cropsHost = modal.querySelector('#zone-preview-crops');
    const img = host?.querySelector('img');

    const drawPreview = () => {
      if (!host || !img?.naturalWidth) return;
      mountZoneOverlay(host, img, zones);
      renderZoneCrops(cropsHost, img, zones);
    };

    if (img?.complete) drawPreview();
    else img?.addEventListener('load', drawPreview);

    modal._onResize = drawPreview;
    window.addEventListener('resize', drawPreview);

    modal.querySelector('[data-action="confirm"]')?.focus();
  });
}
