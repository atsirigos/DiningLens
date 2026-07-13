import { apiFetch, showToast } from './utils.js';

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_MINUTES = 30;
const POLL_INTERVAL_MS = 2500;
const PHASE_POLL_INTERVAL_MS = 500;
const DEFAULT_PLAYBACK_FPS = 5;
const MODE_TIMELAPSE = 'timelapse';
const MODE_VIDEO = 'video';

let status = null;
let phoneSettings = { frameRotation: 0 };
let pollTimer = null;
let starting = false;
let stopping = false;
let playbackIndex = 0;
let playbackPlaying = false;
let playbackTimer = null;
let playbackFps = DEFAULT_PLAYBACK_FPS;
let selectedMode = MODE_TIMELAPSE;
let selectedIntervalSeconds = DEFAULT_INTERVAL_SECONDS;
let selectedMaxMinutes = DEFAULT_MAX_MINUTES;

function playbackFrameMs() {
  return Math.max(50, Math.round(1000 / playbackFps));
}

const container = () => document.getElementById('recording-content');

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(String(hours).padStart(2, '0'));
  parts.push(String(minutes).padStart(2, '0'));
  parts.push(String(seconds).padStart(2, '0'));
  return parts.join(':');
}

function statusBadgeClass() {
  const value = status?.status;
  if (value === 'recording') return 'badge-success';
  if (value === 'starting' || value === 'stopping' || starting || stopping) return 'badge-warning';
  if (value === 'error') return 'badge-danger';
  return 'badge-muted';
}

function statusLabel() {
  if (status?.status === 'recording') return 'Recording';
  if (status?.status === 'starting' || starting) return 'Starting';
  if (status?.status === 'stopping' || stopping) return 'Stopping';
  if (status?.status === 'stopped') return 'Stopped';
  if (status?.status === 'error') return 'Error';
  return 'Idle';
}

function phaseMessage() {
  if (status?.phaseMessage) return status.phaseMessage;
  if (status?.status === 'starting' || starting) return 'Initializing recording…';
  if (status?.status === 'stopping' || stopping) return 'Finalizing recording…';
  return '';
}

function isSessionBusy() {
  return status?.status === 'recording'
    || status?.status === 'starting'
    || status?.status === 'stopping'
    || starting
    || stopping;
}

function stopReasonLabel() {
  switch (status?.stopReason) {
    case 'max_duration':
      return 'Stopped automatically after reaching max duration.';
    case 'too_many_failures':
      return 'Stopped after repeated capture failures.';
    case 'manual':
      return 'Stopped manually.';
    default:
      return '';
  }
}

function phoneCleanupLabel() {
  const cleanup = status?.phoneCleanup;
  if (!cleanup) return '';

  const parts = [];
  const noun = status?.mode === MODE_VIDEO ? 'file' : 'photo';
  if (cleanup.deletedCount > 0) {
    parts.push(`Removed ${cleanup.deletedCount} ${noun}${cleanup.deletedCount === 1 ? '' : 's'} from phone`);
  }
  if (cleanup.screenClosed) {
    parts.push('phone display turned off');
  }
  if (cleanup.failed?.length) {
    parts.push(`${cleanup.failed.length} delete failure${cleanup.failed.length === 1 ? '' : 's'}`);
  }
  if (cleanup.error) {
    parts.push(`cleanup error: ${cleanup.error}`);
  }

  return parts.length ? parts.join('; ') + '.' : '';
}

function currentMode() {
  if (
    status?.status === 'recording'
    || status?.status === 'starting'
    || status?.status === 'stopping'
    || status?.status === 'stopped'
    || status?.status === 'error'
  ) {
    return status.mode || MODE_TIMELAPSE;
  }
  return selectedMode;
}

function isVideoMode() {
  return currentMode() === MODE_VIDEO;
}

function progressPercent() {
  if (!status?.maxDurationMs) return 0;
  return Math.min(100, Math.round((status.elapsedMs / status.maxDurationMs) * 100));
}

function getFrames() {
  return status?.frames || [];
}

function getFormValues() {
  const intervalInput = document.getElementById('recording-interval');
  const maxInput = document.getElementById('recording-max-minutes');
  const modeInput = document.querySelector('input[name="recording-mode"]:checked');
  return {
    mode: modeInput?.value || selectedMode || MODE_TIMELAPSE,
    intervalSeconds: Number(intervalInput?.value) || selectedIntervalSeconds || DEFAULT_INTERVAL_SECONDS,
    maxMinutes: Number(maxInput?.value) || selectedMaxMinutes || DEFAULT_MAX_MINUTES,
  };
}

function syncSelectedCaptureSettingsFromForm() {
  const { mode, intervalSeconds, maxMinutes } = getFormValues();
  selectedMode = mode === MODE_VIDEO ? MODE_VIDEO : MODE_TIMELAPSE;
  selectedIntervalSeconds = intervalSeconds;
  selectedMaxMinutes = maxMinutes;
}

function syncSelectedCaptureSettingsFromStatus() {
  if (!status) return;
  if (status.mode === MODE_VIDEO || status.mode === MODE_TIMELAPSE) {
    selectedMode = status.mode === MODE_VIDEO ? MODE_VIDEO : MODE_TIMELAPSE;
  }
  // Only adopt server values for live/finished sessions — idle defaults are always 30/30.
  if (
    status.status === 'recording'
    || status.status === 'starting'
    || status.status === 'stopping'
    || status.status === 'stopped'
    || status.status === 'error'
  ) {
    if (Number.isFinite(status.intervalSeconds) && status.intervalSeconds > 0) {
      selectedIntervalSeconds = status.intervalSeconds;
    }
    if (Number.isFinite(status.maxMinutes) && status.maxMinutes > 0) {
      selectedMaxMinutes = status.maxMinutes;
    }
  }
}

function getVideos() {
  return status?.videos || [];
}

function stopPlayback() {
  playbackPlaying = false;
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = null;
  }
  syncPlaybackControls();
}

function clampPlaybackIndex() {
  const frames = getFrames();
  if (frames.length === 0) {
    playbackIndex = 0;
    return;
  }
  playbackIndex = Math.min(playbackIndex, frames.length - 1);
}

function showPlaybackFrame() {
  const frames = getFrames();
  const img = document.getElementById('recording-playback-frame');
  const empty = document.getElementById('recording-playback-empty');
  const counter = document.getElementById('recording-playback-counter');
  const scrubber = document.getElementById('recording-scrubber');

  clampPlaybackIndex();

  if (!img || !empty || !counter) return;

  if (frames.length === 0) {
    img.hidden = true;
    empty.hidden = false;
    counter.textContent = '0 / 0';
    if (scrubber) {
      scrubber.max = '0';
      scrubber.value = '0';
      scrubber.disabled = true;
    }
    return;
  }

  const frame = frames[playbackIndex];
  img.src = frame.url;
  img.alt = `Frame ${playbackIndex + 1}: ${frame.file}`;
  img.hidden = false;
  empty.hidden = true;
  counter.textContent = `${playbackIndex + 1} / ${frames.length}`;
  if (scrubber) {
    scrubber.max = String(frames.length - 1);
    scrubber.value = String(playbackIndex);
    scrubber.disabled = false;
  }
}

function syncPlaybackControls() {
  const frames = getFrames();
  const playPauseBtn = document.getElementById('recording-playpause-btn');
  const prevBtn = document.getElementById('recording-prev-btn');
  const nextBtn = document.getElementById('recording-next-btn');

  const hasFrames = frames.length > 0;
  const atStart = playbackIndex <= 0;
  const atEnd = !hasFrames || playbackIndex >= frames.length - 1;

  if (playPauseBtn) {
    playPauseBtn.disabled = !hasFrames;
    playPauseBtn.textContent = playbackPlaying ? 'Pause' : 'Play';
  }
  if (prevBtn) prevBtn.disabled = !hasFrames || atStart;
  if (nextBtn) nextBtn.disabled = !hasFrames || atEnd;
}

function advancePlayback() {
  const frames = getFrames();
  if (frames.length === 0) {
    stopPlayback();
    return;
  }

  if (playbackIndex < frames.length - 1) {
    playbackIndex += 1;
    showPlaybackFrame();
    syncPlaybackControls();
    return;
  }

  if (status?.status === 'recording') {
    syncPlaybackControls();
    return;
  }

  stopPlayback();
}

function startPlayback() {
  const frames = getFrames();
  if (frames.length === 0) return;

  if (playbackIndex >= frames.length - 1 && status?.status !== 'recording') {
    playbackIndex = 0;
    showPlaybackFrame();
  }

  playbackPlaying = true;
  if (playbackTimer) clearInterval(playbackTimer);
  playbackTimer = setInterval(advancePlayback, playbackFrameMs());
  syncPlaybackControls();
}

function togglePlayback() {
  if (playbackPlaying) stopPlayback();
  else startPlayback();
}

function renderConfigCard() {
  const busy = isSessionBusy();
  const mode = currentMode();
  const intervalValue = selectedIntervalSeconds;
  const maxValue = selectedMaxMinutes;

  return `
    <div class="card recording-config">
      <h3 class="recording-section-title">Capture settings</h3>
      <p class="recording-section-desc">
        Choose <strong>photo frames</strong> (timelapse stills) or <strong>full video</strong>
        (phone screen recording via ADB). Files are saved under <code>data/recordings/</code>
        and appear in the Gallery.
      </p>

      <fieldset class="recording-mode-fieldset" ${busy ? 'disabled' : ''}>
        <legend class="recording-mode-legend">Recording mode</legend>
        <div class="recording-mode-options">
          <label class="recording-mode-option">
            <input
              type="radio"
              name="recording-mode"
              value="${MODE_TIMELAPSE}"
              ${mode === MODE_TIMELAPSE ? 'checked' : ''}
            >
            <span class="recording-mode-card">
              <strong>Photo frames</strong>
              <span>Interval still photos from the phone camera (existing timelapse).</span>
            </span>
          </label>
          <label class="recording-mode-option">
            <input
              type="radio"
              name="recording-mode"
              value="${MODE_VIDEO}"
              ${mode === MODE_VIDEO ? 'checked' : ''}
            >
            <span class="recording-mode-card">
              <strong>Full video</strong>
              <span>Continuous MP4 via ADB screenrecord (camera preview on screen). Clips auto-chain every 2 minutes.</span>
            </span>
          </label>
        </div>
      </fieldset>

      <div class="recording-config-grid">
        <div class="form-group" id="recording-interval-group" ${mode === MODE_VIDEO ? 'hidden' : ''}>
          <label for="recording-interval">Frequency (seconds per photo)</label>
          <input
            type="number"
            id="recording-interval"
            min="5"
            max="600"
            step="1"
            value="${intervalValue ?? DEFAULT_INTERVAL_SECONDS}"
            ${busy ? 'disabled' : ''}
          >
        </div>
        <div class="form-group">
          <label for="recording-max-minutes">Max recording length (minutes)</label>
          <input
            type="number"
            id="recording-max-minutes"
            min="1"
            max="240"
            step="1"
            value="${maxValue}"
            ${busy ? 'disabled' : ''}
          >
        </div>
        <div class="form-group" id="recording-rotation-group" ${mode === MODE_VIDEO ? 'hidden' : ''}>
          <label for="recording-frame-rotation">Camera photo rotation</label>
          <select id="recording-frame-rotation" ${busy ? 'disabled' : ''}>
            <option value="0" ${phoneSettings.frameRotation === 0 ? 'selected' : ''}>0° (no rotation)</option>
            <option value="90" ${phoneSettings.frameRotation === 90 ? 'selected' : ''}>90° clockwise</option>
            <option value="180" ${phoneSettings.frameRotation === 180 ? 'selected' : ''}>180°</option>
            <option value="270" ${phoneSettings.frameRotation === 270 ? 'selected' : ''}>270° clockwise</option>
          </select>
          <p class="form-hint" style="margin-top: 0.35rem; font-size: 0.8rem; color: var(--color-text-muted);">
            Applies to every photo captured from the phone until you change it again.
          </p>
        </div>
      </div>
      <div class="recording-actions">
        <button
          type="button"
          class="btn btn-primary"
          id="recording-start-btn"
          ${busy ? 'disabled' : ''}
        >
          ${starting || status?.status === 'starting'
            ? 'Starting…'
            : (mode === MODE_VIDEO ? 'Start video' : 'Start recording')}
        </button>
        <button
          type="button"
          class="btn btn-ghost"
          id="recording-stop-btn"
          ${status?.status !== 'recording' || stopping || status?.status === 'stopping' ? 'disabled' : ''}
        >
          ${stopping || status?.status === 'stopping' ? 'Stopping…' : 'Stop recording'}
        </button>
      </div>
    </div>`;
}

function renderStatusCard() {
  const isActive = status?.status === 'recording';
  const video = isVideoMode();
  const phase = phaseMessage();

  return `
    <div class="card recording-status" id="recording-status-card">
      <div class="recording-status-header">
        <h3 class="recording-section-title">Session status</h3>
        <span class="badge ${statusBadgeClass()}" id="recording-status-badge">${statusLabel()}</span>
      </div>

      <p class="recording-phase" id="recording-phase" ${phase ? '' : 'hidden'}>
        <span class="recording-phase-spinner" aria-hidden="true"></span>
        <span id="recording-phase-text">${phase}</span>
      </p>

      <div class="recording-status-grid">
        <div class="recording-stat">
          <span class="recording-stat-label">Mode</span>
          <span class="recording-stat-value" id="recording-mode-label">${video ? 'Full video' : 'Photo frames'}</span>
        </div>
        <div class="recording-stat">
          <span class="recording-stat-label">Elapsed</span>
          <span class="recording-stat-value" id="recording-elapsed">${formatDuration(status?.elapsedMs || 0)}</span>
        </div>
        <div class="recording-stat">
          <span class="recording-stat-label">Remaining</span>
          <span class="recording-stat-value" id="recording-remaining">${formatDuration(status?.remainingMs || 0)}</span>
        </div>
        <div class="recording-stat">
          <span class="recording-stat-label">${video ? 'Video clips' : 'Frames captured'}</span>
          <span class="recording-stat-value" id="recording-frames-count">
            ${video ? (status?.videoSegments ?? status?.videos?.length ?? 0) : (status?.framesCaptured ?? 0)}
          </span>
        </div>
        <div class="recording-stat" id="recording-next-stat" ${video ? 'hidden' : ''}>
          <span class="recording-stat-label">Next capture in</span>
          <span class="recording-stat-value" id="recording-next-capture">
            ${!video && isActive && status?.nextCaptureInMs != null
              ? formatDuration(status.nextCaptureInMs)
              : '—'}
          </span>
        </div>
      </div>

      <div class="recording-progress-wrap">
        <div class="recording-progress-label">
          <span>Max duration progress</span>
          <span id="recording-progress-pct">${progressPercent()}%</span>
        </div>
        <div class="recording-progress-bar" aria-hidden="true">
          <div class="recording-progress-fill" id="recording-progress-fill" style="width: ${progressPercent()}%"></div>
        </div>
      </div>

      <p class="recording-meta" id="recording-session-meta" ${status?.sessionId ? '' : 'hidden'}>
        Session: <code>${status?.sessionId || ''}</code>
      </p>

      <p class="recording-inline-error" id="recording-last-error" ${status?.lastError ? '' : 'hidden'}>
        ${status?.lastError ? `Last error: ${status.lastError}` : ''}
      </p>

      <p class="recording-inline-note" id="recording-stop-reason" ${status?.stopReason ? '' : 'hidden'}>
        ${status?.stopReason ? stopReasonLabel() : ''}
      </p>

      <p class="recording-inline-note" id="recording-phone-cleanup" ${status?.phoneCleanup ? '' : 'hidden'}>
        ${status?.phoneCleanup ? phoneCleanupLabel() : ''}
      </p>
    </div>`;
}

function renderPlaybackCard() {
  if (isVideoMode()) {
    const videos = getVideos();
    const primary = videos[0];
    return `
      <div class="card recording-playback" id="recording-playback-card">
        <div class="recording-status-header">
          <h3 class="recording-section-title">Video playback</h3>
          <span class="recording-playback-counter" id="recording-playback-counter">
            ${videos.length} clip${videos.length === 1 ? '' : 's'}
          </span>
        </div>
        <div class="recording-playback-viewport recording-video-viewport">
          ${primary
            ? `<video id="recording-video-player" class="recording-video-player" controls src="${primary.url}"></video>
               <p class="recording-inline-note" style="margin-top:0.75rem;">
                 <a href="${primary.url}" download="${primary.file}">Download ${primary.file}</a>
               </p>`
            : '<p id="recording-playback-empty" class="recording-playback-empty">No video clips yet. Recording will appear here when pulled from the phone.</p>'}
        </div>
        ${videos.length > 1
          ? `<ul class="recording-video-list">${videos.map((v, i) => `
              <li>
                <button type="button" class="btn btn-ghost btn-sm recording-video-pick" data-video-url="${v.url}">
                  Clip ${i + 1}: ${v.file}
                </button>
              </li>`).join('')}</ul>`
          : ''}
      </div>`;
  }

  return `
    <div class="card recording-playback" id="recording-playback-card">
      <div class="recording-status-header">
        <h3 class="recording-section-title">Playback</h3>
        <span class="recording-playback-counter" id="recording-playback-counter">0 / 0</span>
      </div>

      <div class="recording-playback-viewport">
        <img id="recording-playback-frame" class="recording-playback-frame" alt="" hidden>
        <p id="recording-playback-empty" class="recording-playback-empty">No frames captured yet.</p>
      </div>

      <input
        type="range"
        id="recording-scrubber"
        class="recording-scrubber"
        min="0"
        max="0"
        value="0"
        step="1"
        aria-label="Playback position"
        disabled
      >

      <div class="recording-playback-controls">
        <button type="button" class="btn btn-ghost btn-sm" id="recording-prev-btn" disabled>‹ Prev</button>
        <button type="button" class="btn btn-primary btn-sm" id="recording-playpause-btn" disabled>Play</button>
        <button type="button" class="btn btn-ghost btn-sm" id="recording-next-btn" disabled>Next ›</button>
        <label class="recording-speed">
          <span>Speed</span>
          <select id="recording-speed-select">
            <option value="1">1 fps</option>
            <option value="2">2 fps</option>
            <option value="5">5 fps</option>
            <option value="10">10 fps</option>
            <option value="20">20 fps</option>
          </select>
        </label>
      </div>
    </div>`;
}

function updateLiveStatus() {
  const isActive = status?.status === 'recording';
  const video = isVideoMode();
  const prevFrameCount = Number(document.getElementById('recording-frames-count')?.textContent || 0);
  const phase = phaseMessage();

  document.getElementById('recording-status-badge')?.classList.remove(
    'badge-success',
    'badge-muted',
    'badge-danger',
    'badge-warning',
  );
  const badge = document.getElementById('recording-status-badge');
  if (badge) {
    badge.classList.add(statusBadgeClass());
    badge.textContent = statusLabel();
  }

  const phaseEl = document.getElementById('recording-phase');
  const phaseText = document.getElementById('recording-phase-text');
  if (phaseEl) phaseEl.hidden = !phase;
  if (phaseText) phaseText.textContent = phase;

  const startBtn = document.getElementById('recording-start-btn');
  if (startBtn) {
    const busy = isSessionBusy();
    startBtn.disabled = busy;
    startBtn.textContent = starting || status?.status === 'starting'
      ? 'Starting…'
      : (isVideoMode() ? 'Start video' : 'Start recording');
  }
  const stopBtn = document.getElementById('recording-stop-btn');
  if (stopBtn) {
    stopBtn.disabled = status?.status !== 'recording' || stopping;
    stopBtn.textContent = stopping || status?.status === 'stopping' ? 'Stopping…' : 'Stop recording';
  }

  const modeLabel = document.getElementById('recording-mode-label');
  if (modeLabel) modeLabel.textContent = video ? 'Full video' : 'Photo frames';

  const elapsed = document.getElementById('recording-elapsed');
  if (elapsed) elapsed.textContent = formatDuration(status?.elapsedMs || 0);

  const remaining = document.getElementById('recording-remaining');
  if (remaining) remaining.textContent = formatDuration(status?.remainingMs || 0);

  const framesCount = document.getElementById('recording-frames-count');
  if (framesCount) {
    framesCount.textContent = String(
      video
        ? (status?.videoSegments ?? status?.videos?.length ?? 0)
        : (status?.framesCaptured ?? 0),
    );
  }

  const nextStat = document.getElementById('recording-next-stat');
  if (nextStat) nextStat.hidden = video;

  const nextCapture = document.getElementById('recording-next-capture');
  if (nextCapture) {
    nextCapture.textContent = !video && isActive && status?.nextCaptureInMs != null
      ? formatDuration(status.nextCaptureInMs)
      : '—';
  }

  const progressPct = document.getElementById('recording-progress-pct');
  if (progressPct) progressPct.textContent = `${progressPercent()}%`;

  const progressFill = document.getElementById('recording-progress-fill');
  if (progressFill) progressFill.style.width = `${progressPercent()}%`;

  const sessionMeta = document.getElementById('recording-session-meta');
  if (sessionMeta) {
    sessionMeta.hidden = !status?.sessionId;
    sessionMeta.innerHTML = `Session: <code>${status?.sessionId || ''}</code>`;
  }

  const lastError = document.getElementById('recording-last-error');
  if (lastError) {
    lastError.hidden = !status?.lastError;
    lastError.textContent = status?.lastError ? `Last error: ${status.lastError}` : '';
  }

  const stopReason = document.getElementById('recording-stop-reason');
  if (stopReason) {
    stopReason.hidden = !status?.stopReason;
    stopReason.textContent = status?.stopReason ? stopReasonLabel() : '';
  }

  const phoneCleanup = document.getElementById('recording-phone-cleanup');
  if (phoneCleanup) {
    phoneCleanup.hidden = !status?.phoneCleanup;
    phoneCleanup.textContent = status?.phoneCleanup ? phoneCleanupLabel() : '';
  }

  if (video) {
    const counter = document.getElementById('recording-playback-counter');
    const videos = getVideos();
    if (counter) counter.textContent = `${videos.length} clip${videos.length === 1 ? '' : 's'}`;
    return;
  }

  const newFrameCount = status?.framesCaptured ?? 0;
  if (newFrameCount > prevFrameCount && playbackPlaying) {
    advancePlayback();
  } else {
    showPlaybackFrame();
    syncPlaybackControls();
  }
}

function render() {
  container().innerHTML = `
    <div class="recording-panel">
      <div class="recording-notice card">
        <p>
          <strong>Server-side recording.</strong> The capture loop runs on this machine, so it
          continues even if you close this tab. Make sure your phone is connected in
          Phone Configuration first. Full video records the phone screen (open the camera
          preview for the best meal view).
        </p>
      </div>
      ${renderConfigCard()}
      ${renderStatusCard()}
      ${renderPlaybackCard()}
    </div>`;

  bindEvents();
  if (!isVideoMode()) {
    showPlaybackFrame();
    syncPlaybackControls();
    if (playbackPlaying) startPlayback();
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling({ fast = false } = {}) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      status = await apiFetch('/api/recording/status');
      updateLiveStatus();
      const active = status.status === 'recording'
        || status.status === 'starting'
        || status.status === 'stopping'
        || starting
        || stopping;
      if (!active) {
        stopPolling();
        syncPlaybackControls();
        return;
      }
      if (status.status === 'recording' && fast && !starting && !stopping) {
        startPolling({ fast: false });
      }
    } catch (err) {
      console.error('recording status poll failed:', err);
    }
  }, fast ? PHASE_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
}

async function loadStatus() {
  status = await apiFetch('/api/recording/status');
  syncSelectedCaptureSettingsFromStatus();
  if (status.status === 'recording' || status.status === 'starting' || status.status === 'stopping') {
    startPolling({ fast: status.status !== 'recording' });
  }
}

function bindEvents() {
  document.querySelectorAll('input[name="recording-mode"]').forEach((input) => {
    input.addEventListener('change', (e) => {
      selectedMode = e.target.value === MODE_VIDEO ? MODE_VIDEO : MODE_TIMELAPSE;
      const intervalGroup = document.getElementById('recording-interval-group');
      const rotationGroup = document.getElementById('recording-rotation-group');
      if (intervalGroup) intervalGroup.hidden = selectedMode === MODE_VIDEO;
      if (rotationGroup) rotationGroup.hidden = selectedMode === MODE_VIDEO;
      const startBtn = document.getElementById('recording-start-btn');
      if (startBtn && !starting) {
        startBtn.textContent = selectedMode === MODE_VIDEO ? 'Start video' : 'Start recording';
      }
    });
  });

  document.getElementById('recording-interval')?.addEventListener('change', () => {
    selectedIntervalSeconds = Number(document.getElementById('recording-interval')?.value)
      || selectedIntervalSeconds
      || DEFAULT_INTERVAL_SECONDS;
  });
  document.getElementById('recording-max-minutes')?.addEventListener('change', () => {
    selectedMaxMinutes = Number(document.getElementById('recording-max-minutes')?.value)
      || selectedMaxMinutes
      || DEFAULT_MAX_MINUTES;
  });

  document.getElementById('recording-start-btn')?.addEventListener('click', async () => {
    syncSelectedCaptureSettingsFromForm();
    const { mode, intervalSeconds, maxMinutes } = {
      mode: selectedMode,
      intervalSeconds: selectedIntervalSeconds,
      maxMinutes: selectedMaxMinutes,
    };

    if (selectedMode === MODE_TIMELAPSE) {
      if (intervalSeconds < 5 || intervalSeconds > 600) {
        showToast('Frequency must be between 5 and 600 seconds.', 'error');
        return;
      }
    }
    if (maxMinutes < 1 || maxMinutes > 240) {
      showToast('Max recording length must be between 1 and 240 minutes.', 'error');
      return;
    }

    starting = true;
    render();
    startPolling({ fast: true });

    try {
      stopPlayback();
      playbackIndex = 0;
      const body = { mode: selectedMode, maxMinutes };
      if (selectedMode === MODE_TIMELAPSE) body.intervalSeconds = intervalSeconds;
      status = await apiFetch('/api/recording/start', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      syncSelectedCaptureSettingsFromStatus();
      showToast(selectedMode === MODE_VIDEO ? 'Video recording started' : 'Recording started', 'success');
      startPolling({ fast: false });
    } catch (err) {
      showToast(err.message, 'error');
      stopPolling();
    } finally {
      starting = false;
      render();
      if (status?.status === 'recording') startPolling({ fast: false });
    }
  });

  document.getElementById('recording-stop-btn')?.addEventListener('click', async () => {
    stopping = true;
    render();
    startPolling({ fast: true });

    try {
      status = await apiFetch('/api/recording/stop', { method: 'POST' });
      stopPolling();
      showToast('Recording stopped', 'info');
      updateLiveStatus();
      syncPlaybackControls();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      stopping = false;
      render();
    }
  });

  document.querySelectorAll('.recording-video-pick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const player = document.getElementById('recording-video-player');
      if (player && btn.dataset.videoUrl) {
        player.src = btn.dataset.videoUrl;
        player.play?.();
      }
    });
  });

  document.getElementById('recording-playpause-btn')?.addEventListener('click', togglePlayback);
  document.getElementById('recording-prev-btn')?.addEventListener('click', () => {
    stopPlayback();
    if (playbackIndex > 0) {
      playbackIndex -= 1;
      showPlaybackFrame();
      syncPlaybackControls();
    }
  });
  document.getElementById('recording-next-btn')?.addEventListener('click', () => {
    const frames = getFrames();
    stopPlayback();
    if (playbackIndex < frames.length - 1) {
      playbackIndex += 1;
      showPlaybackFrame();
      syncPlaybackControls();
    }
  });
  document.getElementById('recording-scrubber')?.addEventListener('input', (e) => {
    stopPlayback();
    playbackIndex = Number(e.target.value) || 0;
    showPlaybackFrame();
    syncPlaybackControls();
  });

  const speedSelect = document.getElementById('recording-speed-select');
  if (speedSelect) {
    speedSelect.value = String(playbackFps);
    speedSelect.addEventListener('change', (e) => {
      playbackFps = Number(e.target.value) || DEFAULT_PLAYBACK_FPS;
      if (playbackPlaying) startPlayback();
    });
  }

  document.getElementById('recording-frame-rotation')?.addEventListener('change', async (e) => {
    const frameRotation = Number(e.target.value) || 0;
    try {
      await apiFetch('/api/phone/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameRotation }),
      });
      phoneSettings.frameRotation = frameRotation;
      showToast(`Camera rotation set to ${frameRotation}°`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
      e.target.value = String(phoneSettings.frameRotation);
    }
  });
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const [settings] = await Promise.all([
      apiFetch('/api/settings'),
      loadStatus(),
    ]);
    phoneSettings = { frameRotation: settings.phone?.frameRotation || 0 };
    render();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <h3>Failed to load recording panel</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}

export function teardown() {
  stopPolling();
  stopPlayback();
}
