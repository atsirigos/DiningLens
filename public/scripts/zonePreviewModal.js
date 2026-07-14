import { mountZoneOverlay } from './zoneOverlay.js';
import { cropZoneToDataUrl } from './zoneGeometry.js';

function removeModal(modal) {
  if (modal?._onResize) {
    window.removeEventListener('resize', modal._onResize);
  }
  modal?.remove();
}

function renderZoneCrops(host, img, zones, orientationDeg) {
  if (!host) return;
  if (!zones?.length || !img?.naturalWidth) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = zones.map((zone) => {
    const src = cropZoneToDataUrl(img, zone, 0.9, orientationDeg);
    return `
      <figure class="analysis-zone-crop">
        <img src="${src}" alt="Crop: ${zone.name}" loading="eager">
        <figcaption>${zone.name}</figcaption>
      </figure>`;
  }).join('');
}

function fileSrc(filePath, filename) {
  const path = filePath || filename;
  return `/api/file/${String(path).split('/').map(encodeURIComponent).join('/')}`;
}

function formatTimestamp(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const whole = Math.floor(rem);
  const frac = Math.round((rem - whole) * 10);
  return `${m}:${String(whole).padStart(2, '0')}.${frac}`;
}

function captureVideoStill(video) {
  if (!video?.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

/**
 * Confirm processing. For videos, always shows a scrubber so the user picks a frame
 * before any API spend. Resolves `{ confirmed: false }` or
 * `{ confirmed: true, frameTimeSec?: number }`.
 */
export function confirmZoneProcessing({
  filename,
  filePath,
  zones = [],
  orientationDeg = null,
  mediaType = 'image',
} = {}) {
  const isVideo = mediaType === 'video';
  const hasZones = Array.isArray(zones) && zones.length > 0;

  // Photos with no zones: nothing to preview.
  if (!isVideo && !hasZones) {
    return Promise.resolve({ confirmed: true });
  }

  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'zone-preview-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'zone-preview-title');

    const mediaPath = filePath || filename;
    let selectedTimeSec = 0.5;

    modal.innerHTML = `
      <div class="zone-preview-backdrop" data-action="cancel"></div>
      <div class="zone-preview-dialog glass">
        <div class="zone-preview-header">
          <h3 id="zone-preview-title">${isVideo ? 'Pick a frame to analyze' : 'Confirm zone crops'}</h3>
          <p class="zone-preview-subtitle">
            ${isVideo
    ? `Scrub <strong>${filename}</strong> and choose the frame that will be sent to the AI. No API call happens until you confirm.`
    : `Review how <strong>${filename}</strong> will be split before sending to the AI.`}
            ${hasZones ? ' Each zone crop is a separate API call.' : ''}
          </p>
        </div>
        <div class="zone-preview-body">
          ${isVideo ? `
            <section class="zone-preview-section zone-preview-scrubber-section">
              <h4>Scrub video</h4>
              <div class="zone-frame-picker">
                <video class="zone-frame-picker-video" src="${fileSrc(mediaPath)}" preload="metadata" playsinline></video>
                <div class="zone-frame-picker-controls">
                  <button type="button" class="btn btn-ghost btn-sm zone-frame-play" aria-label="Play or pause">Play</button>
                  <input type="range" class="zone-frame-scrubber" min="0" max="1" step="0.05" value="0.5" aria-label="Frame position">
                  <span class="zone-frame-time">0:00.5</span>
                </div>
                <button type="button" class="btn btn-ghost btn-sm zone-frame-use">Use current frame for preview</button>
              </div>
            </section>
          ` : ''}
          <section class="zone-preview-section">
            <h4>${isVideo ? 'Selected frame' : 'Full photo'}${hasZones ? ' with zones' : ''}</h4>
            <div class="zone-photo-host zone-preview-photo-host">
              <img class="zone-preview-still" alt="${filename}" ${isVideo ? '' : `src="${fileSrc(mediaPath)}"`}>
            </div>
            ${isVideo ? `<p class="zone-frame-selected-label">Frame at <span class="zone-frame-selected-time">0:00.5</span></p>` : ''}
          </section>
          ${hasZones ? `
            <section class="zone-preview-section">
              <h4>Zone crops (${zones.length})</h4>
              <div class="zone-preview-crops-grid" id="zone-preview-crops"></div>
            </section>
          ` : ''}
        </div>
        <div class="zone-preview-actions">
          <button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-action="confirm">Confirm &amp; Process</button>
        </div>
      </div>`;

    const finish = (payload) => {
      removeModal(modal);
      document.removeEventListener('keydown', onKeyDown);
      resolve(payload);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') finish({ confirmed: false });
    };

    modal.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
      finish({
        confirmed: true,
        ...(isVideo ? { frameTimeSec: selectedTimeSec } : {}),
      });
    });
    modal.querySelectorAll('[data-action="cancel"]').forEach((el) => {
      el.addEventListener('click', () => finish({ confirmed: false }));
    });

    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(modal);

    const host = modal.querySelector('.zone-preview-photo-host');
    const cropsHost = modal.querySelector('#zone-preview-crops');
    const stillImg = modal.querySelector('.zone-preview-still');

    const drawPreview = () => {
      if (!host || !stillImg?.naturalWidth) return;
      if (hasZones) {
        mountZoneOverlay(host, stillImg, zones, orientationDeg);
        renderZoneCrops(cropsHost, stillImg, zones, orientationDeg);
      }
    };

    if (!isVideo) {
      if (stillImg?.complete) drawPreview();
      else stillImg?.addEventListener('load', drawPreview);
    } else {
      const video = modal.querySelector('.zone-frame-picker-video');
      const scrubber = modal.querySelector('.zone-frame-scrubber');
      const playBtn = modal.querySelector('.zone-frame-play');
      const timeLabel = modal.querySelector('.zone-frame-time');
      const selectedLabel = modal.querySelector('.zone-frame-selected-time');

      const syncTimeLabels = () => {
        if (timeLabel) timeLabel.textContent = formatTimestamp(video.currentTime || 0);
      };

      const applySelectedFrame = () => {
        selectedTimeSec = Math.max(0, Number(video.currentTime) || 0);
        if (selectedLabel) selectedLabel.textContent = formatTimestamp(selectedTimeSec);
        const dataUrl = captureVideoStill(video);
        if (!dataUrl || !stillImg) return;
        stillImg.onload = () => drawPreview();
        stillImg.src = dataUrl;
      };

      const seekTo = (time) => {
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;
        video.currentTime = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
      };

      video.addEventListener('loadedmetadata', () => {
        const duration = video.duration || 1;
        scrubber.min = '0';
        scrubber.max = String(duration);
        scrubber.step = duration > 60 ? '0.1' : '0.05';
        const initial = Math.min(0.5, Math.max(0, duration * 0.1));
        scrubber.value = String(initial);
        seekTo(initial);
      });

      video.addEventListener('seeked', () => {
        syncTimeLabels();
        // Keep preview in sync while scrubbing so the user sees the frame they'll send.
        applySelectedFrame();
      });

      video.addEventListener('timeupdate', () => {
        if (!video.paused) {
          scrubber.value = String(video.currentTime || 0);
          syncTimeLabels();
        }
      });

      scrubber?.addEventListener('input', () => {
        video.pause();
        if (playBtn) playBtn.textContent = 'Play';
        seekTo(Number(scrubber.value) || 0);
      });

      playBtn?.addEventListener('click', () => {
        if (video.paused) {
          video.play?.();
          playBtn.textContent = 'Pause';
        } else {
          video.pause();
          playBtn.textContent = 'Play';
          applySelectedFrame();
        }
      });

      modal.querySelector('.zone-frame-use')?.addEventListener('click', () => {
        video.pause();
        if (playBtn) playBtn.textContent = 'Play';
        applySelectedFrame();
      });
    }

    modal._onResize = drawPreview;
    window.addEventListener('resize', drawPreview);

    modal.querySelector('[data-action="confirm"]')?.focus();
  });
}
