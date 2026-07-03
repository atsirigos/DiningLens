import { apiFetch, showToast } from './utils.js';

const STORAGE_KEY = 'phoneStatusRefreshMode';
const CUSTOM_STORAGE_KEY = 'phoneStatusCustomRefreshSeconds';
const DEFAULT_REFRESH_SECONDS = 3;
const MIN_CUSTOM_SECONDS = 2;
const MAX_CUSTOM_SECONDS = 3600;

const CHART_COLORS = {
  battery: '#6b5ce7',
  temperature: '#e85d8a',
  storage: '#0d9488',
};
const CHART_TEXT = '#475569';
const CHART_GRID = 'rgba(0, 0, 0, 0.06)';

const PRESET_REFRESH_OPTIONS = [
  { value: 0, label: 'Manual only' },
  { value: 3, label: 'Every 3 seconds' },
  { value: 5, label: 'Every 5 seconds' },
  { value: 10, label: 'Every 10 seconds' },
  { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every 60 seconds' },
];

let health = null;
let loadError = null;
let pollTimer = null;
let loading = false;
let refreshConfig = loadRefreshConfig();
let refreshing = false;
let healthHistory = [];
let statusCharts = {};

const container = () => document.getElementById('phone-status-content');

function destroyStatusCharts() {
  Object.values(statusCharts).forEach((chart) => chart.destroy());
  statusCharts = {};
}

function chartIntervalSeconds() {
  const configured = effectiveRefreshSeconds();
  if (configured > 0) return configured;

  const storedIntervals = healthHistory
    .map((point) => point.intervalSec)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (storedIntervals.length) {
    return storedIntervals[storedIntervals.length - 1];
  }

  if (healthHistory.length < 2) return DEFAULT_REFRESH_SECONDS;

  const deltas = [];
  for (let i = 1; i < healthHistory.length; i += 1) {
    const delta = (Date.parse(healthHistory[i].t) - Date.parse(healthHistory[i - 1].t)) / 1000;
    if (delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return DEFAULT_REFRESH_SECONDS;

  deltas.sort((a, b) => a - b);
  return Math.max(1, Math.round(deltas[Math.floor(deltas.length / 2)]));
}

function formatAxisTick(seconds, stepSec) {
  if (stepSec >= 60) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return secs ? `${minutes}:${String(secs).padStart(2, '0')}` : `${minutes}m`;
  }
  return `${Math.round(seconds)}s`;
}

function chartTimeSpanSeconds() {
  if (healthHistory.length < 2) return chartIntervalSeconds();
  const t0 = Date.parse(healthHistory[0].t);
  const t1 = Date.parse(healthHistory[healthHistory.length - 1].t);
  return Math.max(chartIntervalSeconds(), Math.round((t1 - t0) / 1000));
}

function seriesData(field) {
  if (!healthHistory.length) return [];

  const t0 = Date.parse(healthHistory[0].t);
  return healthHistory
    .map((point) => ({
      x: Math.round((Date.parse(point.t) - t0) / 1000),
      y: point[field],
    }))
    .filter((point) => point.y != null);
}

function metricPointCount(metric) {
  return healthHistory.filter((point) => {
    switch (metric) {
      case 'battery':
        return point.battery != null;
      case 'temperature':
        return point.temp != null;
      case 'storage':
        return point.storage != null;
      default:
        return false;
    }
  }).length;
}

function canDrawMetricChart(metric) {
  return healthHistory.length >= 2 && metricPointCount(metric) >= 2;
}

function baseChartOptions({ yMin = undefined, yMax = undefined, yTitle = '' } = {}) {
  const stepSec = chartIntervalSeconds();
  const spanSec = chartTimeSpanSeconds();

  return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        labels: { color: CHART_TEXT },
      },
    },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: spanSec,
        title: {
          display: true,
          text: stepSec >= 60 ? 'Time (min:sec)' : 'Time (seconds)',
          color: CHART_TEXT,
        },
        ticks: {
          stepSize: stepSec,
          color: CHART_TEXT,
          maxTicksLimit: Math.min(12, Math.ceil(spanSec / stepSec) + 1),
          callback: (value) => formatAxisTick(value, stepSec),
        },
        grid: { color: CHART_GRID },
      },
      y: {
        type: 'linear',
        position: 'left',
        min: yMin,
        max: yMax,
        title: yTitle ? { display: true, text: yTitle, color: CHART_TEXT } : undefined,
        ticks: { color: CHART_TEXT },
        grid: { color: CHART_GRID },
      },
    },
  };
}

function buildMetricChartConfig(metric) {
  switch (metric) {
    case 'battery':
      return {
        type: 'line',
        data: {
          datasets: [{
            label: 'Battery %',
            data: seriesData('battery'),
            borderColor: CHART_COLORS.battery,
            backgroundColor: 'rgba(107, 92, 231, 0.12)',
            fill: true,
            spanGaps: true,
            tension: 0.25,
          }],
        },
        options: baseChartOptions({ yMin: 0, yMax: 100, yTitle: '%' }),
      };
    case 'temperature':
      return {
        type: 'line',
        data: {
          datasets: [{
            label: 'Temperature °C',
            data: seriesData('temp'),
            borderColor: CHART_COLORS.temperature,
            backgroundColor: 'rgba(232, 93, 138, 0.12)',
            fill: true,
            spanGaps: true,
            tension: 0.25,
          }],
        },
        options: baseChartOptions({ yTitle: '°C' }),
      };
    case 'storage':
      return {
        type: 'line',
        data: {
          datasets: [{
            label: 'Storage used %',
            data: seriesData('storage'),
            borderColor: CHART_COLORS.storage,
            backgroundColor: 'rgba(13, 148, 136, 0.12)',
            fill: true,
            spanGaps: true,
            tension: 0.25,
          }],
        },
        options: baseChartOptions({ yMin: 0, yMax: 100, yTitle: '%' }),
      };
    default:
      return null;
  }
}

function updateMetricChart(metric) {
  const canvas = document.getElementById(`phone-status-chart-${metric}`);
  const empty = document.getElementById(`phone-status-chart-${metric}-empty`);
  if (!canvas) return;

  if (!canDrawMetricChart(metric)) {
    if (statusCharts[metric]) {
      statusCharts[metric].destroy();
      delete statusCharts[metric];
    }
    canvas.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }

  canvas.hidden = false;
  if (empty) empty.hidden = true;

  const config = buildMetricChartConfig(metric);
  if (!config) return;

  if (statusCharts[metric]) {
    statusCharts[metric].destroy();
    delete statusCharts[metric];
  }

  statusCharts[metric] = new Chart(canvas, config);
}

function updateStatusCharts() {
  ['battery', 'temperature', 'storage'].forEach(updateMetricChart);

  const globalEmpty = document.getElementById('phone-status-charts-empty');
  if (globalEmpty) {
    const anyChart = ['battery', 'temperature', 'storage'].some(canDrawMetricChart);
    globalEmpty.hidden = anyChart || healthHistory.length === 0;
  }
}

async function clearHealthHistory() {
  try {
    await apiFetch('/api/phone/history', { method: 'DELETE' });
    healthHistory = [];
    destroyStatusCharts();
    updateStatusCharts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function loadRefreshConfig() {
  try {
    const mode = localStorage.getItem(STORAGE_KEY);
    const customSeconds = Number(localStorage.getItem(CUSTOM_STORAGE_KEY));

    if (mode === 'custom' && Number.isFinite(customSeconds)) {
      return {
        type: 'custom',
        seconds: clampCustomSeconds(customSeconds),
      };
    }

    const preset = Number(mode);
    if (PRESET_REFRESH_OPTIONS.some((o) => o.value === preset)) {
      return { type: preset === 0 ? 'manual' : 'preset', seconds: preset };
    }

    const legacy = Number(localStorage.getItem('phoneStatusRefreshSeconds'));
    if (PRESET_REFRESH_OPTIONS.some((o) => o.value === legacy)) {
      return { type: legacy === 0 ? 'manual' : 'preset', seconds: legacy };
    }
  } catch {
    /* ignore storage errors */
  }

  return { type: 'preset', seconds: DEFAULT_REFRESH_SECONDS };
}

function clampCustomSeconds(value) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return MIN_CUSTOM_SECONDS;
  return Math.min(MAX_CUSTOM_SECONDS, Math.max(MIN_CUSTOM_SECONDS, parsed));
}

function saveRefreshConfig(config) {
  refreshConfig = config;
  try {
    if (config.type === 'custom') {
      localStorage.setItem(STORAGE_KEY, 'custom');
      localStorage.setItem(CUSTOM_STORAGE_KEY, String(config.seconds));
    } else if (config.type === 'manual') {
      localStorage.setItem(STORAGE_KEY, '0');
    } else {
      localStorage.setItem(STORAGE_KEY, String(config.seconds));
    }
  } catch {
    /* ignore storage errors */
  }
}

function effectiveRefreshSeconds() {
  if (refreshConfig.type === 'manual') return 0;
  return refreshConfig.seconds;
}

function isCustomRefreshMode() {
  return refreshConfig.type === 'custom';
}

function selectedRefreshValue() {
  if (refreshConfig.type === 'custom') return 'custom';
  return String(refreshConfig.seconds);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatLocation(loc) {
  if (!loc?.available) return loc?.reason || 'Unavailable';
  const lat = loc.latitude?.toFixed(5) ?? '?';
  const lng = loc.longitude?.toFixed(5) ?? '?';
  const acc = loc.accuracyMeters != null ? ` ±${Math.round(loc.accuracyMeters)}m` : '';
  const provider = loc.provider ? ` (${loc.provider})` : '';
  return `${lat}, ${lng}${acc}${provider}`;
}

function formatTemperature(celsius) {
  if (celsius == null || !Number.isFinite(celsius)) return '—';
  return `${celsius.toFixed(1)}°C`;
}

function formatBattery(battery) {
  if (battery?.level == null) return '—';
  const charging = battery.charging ? ' (charging)' : '';
  return `${battery.level}%${charging}`;
}

function formatStorage(storage) {
  if (storage?.usedBytes == null || storage?.totalBytes == null) return '—';
  const pct = storage.usedPercent != null ? ` (${storage.usedPercent}%)` : '';
  return `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.totalBytes)}${pct}`;
}

function renderRefreshOptions() {
  const presetOptions = PRESET_REFRESH_OPTIONS.map((option) => `
    <option value="${option.value}" ${selectedRefreshValue() === String(option.value) ? 'selected' : ''}>
      ${escapeHtml(option.label)}
    </option>`).join('');

  const customSelected = isCustomRefreshMode() ? 'selected' : '';
  return `${presetOptions}
    <option value="custom" ${customSelected}>Custom…</option>`;
}

function syncCustomIntervalVisibility() {
  const wrap = document.getElementById('phone-status-custom-wrap');
  if (wrap) wrap.hidden = !isCustomRefreshMode();
}

function renderMetric(label, value, { subtext = '', valueId = '', subtextId = '' } = {}) {
  return `
    <div class="recording-stat phone-health-stat">
      <span class="recording-stat-label">${escapeHtml(label)}</span>
      <span class="recording-stat-value"${valueId ? ` id="${valueId}"` : ''}>${escapeHtml(value)}</span>
      ${subtext || subtextId
        ? `<span class="phone-health-subtext"${subtextId ? ` id="${subtextId}"` : ''}>${escapeHtml(subtext)}</span>`
        : ''}
    </div>`;
}

function renderMetricChartCard(metric, title, hint) {
  return `
    <div class="card phone-status-metric-chart">
      <h4 class="phone-status-chart-title">${escapeHtml(title)}</h4>
      <p class="phone-health-chart-hint phone-status-chart-empty" id="phone-status-chart-${metric}-empty" hidden>
        ${escapeHtml(hint)}
      </p>
      <div class="phone-status-chart-container">
        <canvas id="phone-status-chart-${metric}" hidden></canvas>
      </div>
    </div>`;
}

function renderWarnings() {
  if (!health?.errors?.length) return '';
  return `
    <div class="phone-health-warnings" id="phone-status-warnings">
      ${health.errors.map((e) => `
        <p class="recording-inline-error">${escapeHtml(e.metric)}: ${escapeHtml(e.error)}</p>
      `).join('')}
    </div>`;
}

function renderRefreshControls() {
  return `
    <div class="phone-status-refresh-bar">
      <div class="phone-status-refresh-controls">
        <label class="phone-status-refresh-control">
          <span>Auto-refresh</span>
          <select id="phone-status-refresh-interval">
            ${renderRefreshOptions()}
          </select>
        </label>
        <label
          class="phone-status-custom-interval"
          id="phone-status-custom-wrap"
          ${isCustomRefreshMode() ? '' : 'hidden'}
        >
          <span>Every</span>
          <input
            type="number"
            id="phone-status-custom-seconds"
            min="${MIN_CUSTOM_SECONDS}"
            max="${MAX_CUSTOM_SECONDS}"
            step="1"
            value="${isCustomRefreshMode() ? refreshConfig.seconds : MIN_CUSTOM_SECONDS}"
          >
          <span>seconds</span>
        </label>
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="phone-status-refresh-btn">
        ${refreshing ? 'Refreshing…' : 'Refresh now'}
      </button>
    </div>`;
}

function renderContent() {
  if (loading && !health) {
    return '<div class="loading-center"><div class="loading-spinner"></div></div>';
  }

  if (loadError) {
    return `
      <div class="phone-status-panel">
        ${renderRefreshControls()}
        <div class="empty-state">
          <h3>Could not read phone status</h3>
          <p>${escapeHtml(loadError)}</p>
        </div>
      </div>`;
  }

  if (!health) {
    return `
      <div class="phone-status-panel">
        ${renderRefreshControls()}
        <div class="empty-state">
          <h3>No status data</h3>
          <p>Connect a phone in Phone Configuration, then refresh.</p>
        </div>
      </div>`;
  }

  const deviceName = health.device?.name || 'Unknown device';
  const deviceSerial = health.device?.serial || '';

  return `
    <div class="phone-status-panel">
      ${renderRefreshControls()}
      <div class="card phone-health-card">
        <div class="recording-status-header">
          <div>
            <h3 class="recording-section-title">${escapeHtml(deviceName)}</h3>
            <p class="phone-health-device-meta">${escapeHtml(deviceSerial)}</p>
          </div>
          <span class="badge badge-success">Connected</span>
        </div>

        <div class="recording-status-grid phone-health-grid">
          ${renderMetric('Battery', formatBattery(health.battery), { valueId: 'phone-status-battery' })}
          ${renderMetric('Temperature', formatTemperature(health.battery?.temperatureCelsius), { valueId: 'phone-status-temperature' })}
          ${renderMetric('Storage', formatStorage(health.storage), {
            valueId: 'phone-status-storage',
            subtext: health.storage?.mount ? `Mount: ${health.storage.mount}` : '',
            subtextId: 'phone-status-storage-sub',
          })}
          ${renderMetric('Location', formatLocation(health.location), { valueId: 'phone-status-location' })}
        </div>

        <p class="phone-health-updated" id="phone-status-updated">
          Last updated: ${health.fetchedAt ? new Date(health.fetchedAt).toLocaleTimeString() : '—'}
        </p>

        ${renderWarnings()}
      </div>

      <div class="card phone-health-chart-card">
        <div class="recording-status-header">
          <h3 class="recording-section-title">Status history</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="phone-status-clear-chart">Clear graphs</button>
        </div>
        <p class="phone-health-chart-hint" id="phone-status-charts-empty" hidden>
          Refresh at least twice to start building graphs. Enable auto-refresh or press Refresh now.
        </p>
        <div class="phone-status-charts-grid">
          ${renderMetricChartCard('battery', 'Battery', 'Need at least two battery readings.')}
          ${renderMetricChartCard('temperature', 'Temperature', 'Need at least two temperature readings.')}
          ${renderMetricChartCard('storage', 'Storage', 'Need at least two storage readings.')}
        </div>
      </div>
    </div>`;
}

function updateHealthDisplay() {
  if (!health) return;

  const battery = document.getElementById('phone-status-battery');
  if (battery) battery.textContent = formatBattery(health.battery);

  const temperature = document.getElementById('phone-status-temperature');
  if (temperature) temperature.textContent = formatTemperature(health.battery?.temperatureCelsius);

  const storage = document.getElementById('phone-status-storage');
  if (storage) storage.textContent = formatStorage(health.storage);

  const storageSub = document.getElementById('phone-status-storage-sub');
  if (storageSub) {
    storageSub.textContent = health.storage?.mount ? `Mount: ${health.storage.mount}` : '';
    storageSub.hidden = !health.storage?.mount;
  }

  const location = document.getElementById('phone-status-location');
  if (location) location.textContent = formatLocation(health.location);

  const updated = document.getElementById('phone-status-updated');
  if (updated) {
    updated.textContent = `Last updated: ${health.fetchedAt ? new Date(health.fetchedAt).toLocaleTimeString() : '—'}`;
  }

  const warnings = document.getElementById('phone-status-warnings');
  if (warnings) {
    warnings.outerHTML = renderWarnings();
  } else if (health.errors?.length) {
    document.querySelector('.phone-health-card')?.insertAdjacentHTML('beforeend', renderWarnings());
  }

  updateStatusCharts();
}

function syncRefreshButton() {
  const btn = document.getElementById('phone-status-refresh-btn');
  if (btn) {
    btn.disabled = refreshing;
    btn.textContent = refreshing ? 'Refreshing…' : 'Refresh now';
  }
}

function render() {
  destroyStatusCharts();
  container().innerHTML = renderContent();
  bindEvents();
  syncRefreshButton();
  updateStatusCharts();
}

function bindEvents() {
  document.getElementById('phone-status-refresh-btn')?.addEventListener('click', () => {
    manualRefresh();
  });

  document.getElementById('phone-status-refresh-interval')?.addEventListener('change', (e) => {
    const value = e.target.value;

    if (value === 'custom') {
      saveRefreshConfig({
        type: 'custom',
        seconds: clampCustomSeconds(document.getElementById('phone-status-custom-seconds')?.value),
      });
      syncCustomIntervalVisibility();
      startPolling();
      updateStatusCharts();
      showToast(`Auto-refresh every ${refreshConfig.seconds}s`, 'info');
      document.getElementById('phone-status-custom-seconds')?.focus();
      return;
    }

    const seconds = Number(value);
    if (!PRESET_REFRESH_OPTIONS.some((o) => o.value === seconds)) return;

    if (seconds === 0) {
      saveRefreshConfig({ type: 'manual', seconds: 0 });
    } else {
      saveRefreshConfig({ type: 'preset', seconds });
    }

    syncCustomIntervalVisibility();
    startPolling();
    updateStatusCharts();
    showToast(
      seconds === 0 ? 'Auto-refresh disabled' : `Auto-refresh every ${seconds}s`,
      'info',
    );
  });

  const customInput = document.getElementById('phone-status-custom-seconds');
  customInput?.addEventListener('change', () => applyCustomRefreshInterval());
  customInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyCustomRefreshInterval();
    }
  });

  document.getElementById('phone-status-clear-chart')?.addEventListener('click', async () => {
    await clearHealthHistory();
    showToast('Graph history cleared', 'info');
  });
}

function applyCustomRefreshInterval() {
  const input = document.getElementById('phone-status-custom-seconds');
  if (!input) return;

  const seconds = clampCustomSeconds(input.value);
  input.value = String(seconds);

  saveRefreshConfig({ type: 'custom', seconds });

  const select = document.getElementById('phone-status-refresh-interval');
  if (select) select.value = 'custom';

  syncCustomIntervalVisibility();
  startPolling();
  updateStatusCharts();
  showToast(`Auto-refresh every ${seconds}s`, 'info');
}

async function loadHealth({ silent = false } = {}) {
  if (!silent) loading = true;
  loadError = null;
  try {
    const interval = effectiveRefreshSeconds();
    const query = `refreshIntervalSec=${encodeURIComponent(interval)}`;
    const response = await apiFetch(`/api/phone/health?${query}`);
    health = response;
    healthHistory = Array.isArray(response.history) ? response.history : [];
  } catch (err) {
    health = null;
    loadError = err.message;
    throw err;
  } finally {
    if (!silent) loading = false;
  }
}

async function manualRefresh() {
  if (refreshing) return;

  refreshing = true;
  syncRefreshButton();

  try {
    await loadHealth();
    if (document.getElementById('phone-status-battery')) {
      updateHealthDisplay();
    } else {
      render();
    }
    startPolling();
    showToast('Status refreshed', 'info');
  } catch (err) {
    render();
    showToast(err.message, 'error');
  } finally {
    refreshing = false;
    syncRefreshButton();
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  const seconds = effectiveRefreshSeconds();
  if (!seconds) return;

  pollTimer = setInterval(async () => {
    if (refreshing) return;
    try {
      await loadHealth({ silent: true });
      if (document.getElementById('phone-status-battery')) {
        updateHealthDisplay();
      } else {
        render();
      }
    } catch {
      /* keep showing last good data or error state */
    }
  }, seconds * 1000);
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    await loadHealth();
    render();
    startPolling();
  } catch {
    render();
    startPolling();
  }
}

export function refresh() {
  stopPolling();
  refreshConfig = loadRefreshConfig();
  init();
}

export function destroy() {
  stopPolling();
  destroyStatusCharts();
}
