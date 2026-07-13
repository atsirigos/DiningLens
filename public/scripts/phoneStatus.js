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
const HEALTH_LEVEL_COLORS = {
  safe: '#059669',
  warning: '#d97706',
  critical: '#dc2626',
};
const CHART_TEXT = '#475569';
const CHART_GRID = 'rgba(0, 0, 0, 0.06)';
const CHART_HISTORY_DAYS = 7;
const CHART_VIEW_WINDOW_SEC = 6 * 60 * 60;
const DAY_SEC = 24 * 60 * 60;
const HOUR_SEC = 60 * 60;

/** Battery % thresholds (aligned with charge-control 20–80% target). */
const BATTERY_THRESHOLDS = {
  safeMin: 20,
  safeMax: 80,
  warningLowMax: 19,
  warningHighMin: 81,
  criticalLowMax: 14,
  criticalHighMin: 95,
};

/** Phone battery temperature (°C from dumpsys). */
const TEMPERATURE_THRESHOLDS = {
  safeMin: 10,
  safeMax: 37,
  warningMin: 38,
  warningMax: 42,
  criticalLowMax: 9,
  criticalHighMin: 43,
};

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
/** When true, the visible window tracks the latest sample. */
let chartFollowLatest = true;
/** Absolute end of the visible window (ms); used when not following latest. */
let chartViewEndMs = null;
let chartPanState = null;

const container = () => document.getElementById('phone-status-content');

function destroyStatusCharts() {
  Object.values(statusCharts).forEach((chart) => chart.destroy());
  statusCharts = {};
  chartPanState = null;
}

function resetChartView() {
  chartFollowLatest = true;
  chartViewEndMs = null;
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

function dataSpanSeconds() {
  if (healthHistory.length < 2) return chartIntervalSeconds();
  const t0 = Date.parse(healthHistory[0].t);
  const t1 = Date.parse(healthHistory[healthHistory.length - 1].t);
  return Math.max(chartIntervalSeconds(), Math.round((t1 - t0) / 1000));
}

function chartViewWindowSeconds() {
  return Math.min(CHART_VIEW_WINDOW_SEC, dataSpanSeconds());
}

function chartCanScroll() {
  return dataSpanSeconds() > chartViewWindowSeconds() + 1;
}

function chartViewBounds() {
  const span = dataSpanSeconds();
  const windowSec = chartViewWindowSeconds();
  let endSec;

  if (chartFollowLatest || chartViewEndMs == null) {
    endSec = span;
  } else {
    endSec = Math.round((chartViewEndMs - historyStartMs()) / 1000);
    endSec = Math.min(span, Math.max(windowSec, endSec));
  }

  let startSec = endSec - windowSec;
  if (startSec < 0) {
    startSec = 0;
    endSec = Math.min(span, windowSec);
  }

  return { min: startSec, max: endSec, windowSec, span };
}

function setChartViewEndSec(endSec, { followIfAtEnd = true } = {}) {
  const span = dataSpanSeconds();
  const windowSec = chartViewWindowSeconds();
  const clamped = Math.min(span, Math.max(windowSec, endSec));
  chartFollowLatest = followIfAtEnd && clamped >= span - 1;
  chartViewEndMs = chartFollowLatest ? null : historyStartMs() + clamped * 1000;
  applyChartViewToAll();
  syncChartScrubber();
}

function jumpChartToLatest() {
  chartFollowLatest = true;
  chartViewEndMs = null;
  applyChartViewToAll();
  syncChartScrubber();
}

function chartAxisStepSeconds(viewSec) {
  if (viewSec >= DAY_SEC) return HOUR_SEC * 4;
  if (viewSec >= HOUR_SEC * 6) return HOUR_SEC;
  if (viewSec >= HOUR_SEC * 3) return 30 * 60;
  if (viewSec >= HOUR_SEC) return 15 * 60;
  if (viewSec >= 15 * 60) return 5 * 60;
  const sampleStep = chartIntervalSeconds();
  return Math.max(sampleStep, Math.ceil(viewSec / 10));
}

function historyStartMs() {
  if (!healthHistory.length) return Date.now();
  return Date.parse(healthHistory[0].t);
}

function formatAxisTick(seconds) {
  const date = new Date(historyStartMs() + seconds * 1000);

  if (chartViewBounds().windowSec >= HOUR_SEC) {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function chartAxisTitle() {
  if (chartFollowLatest && chartViewWindowSeconds() >= CHART_VIEW_WINDOW_SEC * 0.99) {
    return 'Last 6 hours';
  }
  return 'Time';
}

function seriesData(field) {
  if (!healthHistory.length) return [];

  const t0 = historyStartMs();
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

function baseChartOptions({ yMin = undefined, yMax = undefined, yStep = undefined, yTitle = '' } = {}) {
  const { min, max, windowSec } = chartViewBounds();
  const stepSec = chartAxisStepSeconds(windowSec);

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
      tooltip: {
        callbacks: {
          title: (items) => {
            const x = items?.[0]?.parsed?.x;
            if (x == null) return '';
            return new Date(historyStartMs() + x * 1000).toLocaleString();
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        min,
        max,
        title: {
          display: true,
          text: chartAxisTitle(),
          color: CHART_TEXT,
        },
        ticks: {
          stepSize: stepSec,
          color: CHART_TEXT,
          maxTicksLimit: 8,
          callback: (value) => formatAxisTick(value),
        },
        grid: { color: CHART_GRID },
      },
      y: {
        type: 'linear',
        position: 'left',
        min: yMin,
        max: yMax,
        title: yTitle ? { display: true, text: yTitle, color: CHART_TEXT } : undefined,
        ticks: {
          color: CHART_TEXT,
          ...(yStep != null ? { stepSize: yStep } : {}),
        },
        grid: { color: CHART_GRID },
      },
    },
  };
}

function evaluateBatteryLevel(level) {
  if (level == null || !Number.isFinite(level)) return null;
  if (level <= BATTERY_THRESHOLDS.criticalLowMax || level >= BATTERY_THRESHOLDS.criticalHighMin) {
    return 'critical';
  }
  if (level <= BATTERY_THRESHOLDS.warningLowMax || level >= BATTERY_THRESHOLDS.warningHighMin) {
    return 'warning';
  }
  return 'safe';
}

function evaluateTemperatureLevel(celsius) {
  if (celsius == null || !Number.isFinite(celsius)) return null;
  if (celsius <= TEMPERATURE_THRESHOLDS.criticalLowMax || celsius >= TEMPERATURE_THRESHOLDS.criticalHighMin) {
    return 'critical';
  }
  if (celsius >= TEMPERATURE_THRESHOLDS.warningMin && celsius <= TEMPERATURE_THRESHOLDS.warningMax) {
    return 'warning';
  }
  return 'safe';
}

function healthLevelLabel(level) {
  switch (level) {
    case 'safe':
      return 'Safe';
    case 'warning':
      return 'Caution';
    case 'critical':
      return 'Critical';
    default:
      return '';
  }
}

function healthLevelColor(level) {
  return HEALTH_LEVEL_COLORS[level] || CHART_TEXT;
}

function batteryLevelSubtext(level) {
  const status = healthLevelLabel(level);
  if (!status) return '';
  return `${status} · target ${BATTERY_THRESHOLDS.safeMin}–${BATTERY_THRESHOLDS.safeMax}%`;
}

function temperatureLevelSubtext(level) {
  const status = healthLevelLabel(level);
  if (!status) return '';
  return `${status} · target ${TEMPERATURE_THRESHOLDS.safeMin}–${TEMPERATURE_THRESHOLDS.safeMax}°C`;
}

function segmentColorForMetric(metric, value) {
  const level = metric === 'battery'
    ? evaluateBatteryLevel(value)
    : evaluateTemperatureLevel(value);
  return level ? healthLevelColor(level) : 'rgba(71, 85, 105, 0.35)';
}

function temperatureYScaleBounds() {
  const TEMP_STEP = 5;
  const temps = healthHistory
    .map((point) => point.temp)
    .filter((value) => value != null && Number.isFinite(value));
  if (!temps.length) return { yStep: TEMP_STEP };

  let yMin = Math.min(...temps);
  let yMax = Math.max(...temps);

  if (yMin === yMax) {
    yMin -= TEMP_STEP;
    yMax += TEMP_STEP;
  }

  yMin = Math.floor(yMin / TEMP_STEP) * TEMP_STEP;
  yMax = Math.ceil(yMax / TEMP_STEP) * TEMP_STEP;
  if (yMax <= yMin) yMax = yMin + TEMP_STEP;

  return { yMin, yMax, yStep: TEMP_STEP };
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
            borderColor: healthLevelColor(evaluateBatteryLevel(health?.battery?.level)),
            backgroundColor: 'rgba(5, 150, 105, 0.08)',
            fill: true,
            spanGaps: true,
            tension: 0.25,
            segment: {
              borderColor: (ctx) => segmentColorForMetric('battery', ctx.p1?.parsed?.y),
            },
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
            borderColor: healthLevelColor(evaluateTemperatureLevel(health?.battery?.temperatureCelsius)),
            backgroundColor: 'rgba(5, 150, 105, 0.08)',
            fill: true,
            spanGaps: true,
            tension: 0.25,
            segment: {
              borderColor: (ctx) => segmentColorForMetric('temperature', ctx.p1?.parsed?.y),
            },
          }],
        },
        options: baseChartOptions({ ...temperatureYScaleBounds(), yTitle: '°C' }),
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
    const chart = statusCharts[metric];
    chart.data.datasets = config.data.datasets;
    const { min, max, windowSec } = chartViewBounds();
    chart.options.scales.x.min = min;
    chart.options.scales.x.max = max;
    chart.options.scales.x.title.text = chartAxisTitle();
    chart.options.scales.x.ticks.stepSize = chartAxisStepSeconds(windowSec);
    if (metric === 'temperature') {
      const { yMin, yMax, yStep } = temperatureYScaleBounds();
      chart.options.scales.y.min = yMin;
      chart.options.scales.y.max = yMax;
      chart.options.scales.y.ticks.stepSize = yStep;
    }
    chart.update(chartPanState ? 'none' : undefined);
    canvas.parentElement?.classList.toggle('phone-status-chart-container--scrollable', chartCanScroll());
    return;
  }

  statusCharts[metric] = new Chart(canvas, config);
  bindChartPan(canvas);
  canvas.parentElement?.classList.toggle('phone-status-chart-container--scrollable', chartCanScroll());
}

function applyChartViewToAll() {
  const { min, max, windowSec } = chartViewBounds();
  const stepSec = chartAxisStepSeconds(windowSec);

  Object.values(statusCharts).forEach((chart) => {
    chart.options.scales.x.min = min;
    chart.options.scales.x.max = max;
    chart.options.scales.x.title.text = chartAxisTitle();
    chart.options.scales.x.ticks.stepSize = stepSec;
    chart.update('none');
  });

  document.querySelectorAll('.phone-status-chart-container').forEach((el) => {
    el.classList.toggle('phone-status-chart-container--scrollable', chartCanScroll());
  });
}

function syncChartScrubber() {
  const scrubber = document.getElementById('phone-status-chart-scrubber');
  const range = document.getElementById('phone-status-chart-range');
  const latestBtn = document.getElementById('phone-status-chart-latest');
  if (!scrubber || !range) return;

  const canScroll = chartCanScroll();
  scrubber.hidden = !canScroll;
  if (!canScroll) return;

  const { max, windowSec, span } = chartViewBounds();
  const scrubMax = Math.max(0, span - windowSec);
  range.min = '0';
  range.max = String(scrubMax);
  range.step = String(Math.max(1, Math.round(windowSec / 100)));
  range.value = String(Math.round(max - windowSec));
  if (latestBtn) latestBtn.disabled = chartFollowLatest;
}

function bindChartPan(canvas) {
  if (canvas.dataset.panBound === '1') return;
  canvas.dataset.panBound = '1';

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    if (!chartCanScroll()) return;
    const chart = Object.values(statusCharts).find((c) => c.canvas === canvas);
    if (!chart?.scales?.x) return;

    chartPanState = {
      pointerId: e.pointerId,
      lastX: e.clientX,
    };
    canvas.setPointerCapture(e.pointerId);
    canvas.parentElement?.classList.add('is-panning');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!chartPanState || chartPanState.pointerId !== e.pointerId) return;
    const chart = Object.values(statusCharts).find((c) => c.canvas === canvas);
    const xScale = chart?.scales?.x;
    if (!xScale?.width) return;

    const dx = e.clientX - chartPanState.lastX;
    chartPanState.lastX = e.clientX;
    const deltaSec = -dx * ((xScale.max - xScale.min) / xScale.width);
    setChartViewEndSec(chartViewBounds().max + deltaSec, { followIfAtEnd: true });
  });

  const endPan = (e) => {
    if (!chartPanState || chartPanState.pointerId !== e.pointerId) return;
    chartPanState = null;
    canvas.parentElement?.classList.remove('is-panning');
  };

  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);

  canvas.addEventListener('wheel', (e) => {
    if (!chartCanScroll()) return;
    e.preventDefault();
    const chart = Object.values(statusCharts).find((c) => c.canvas === canvas);
    const xScale = chart?.scales?.x;
    if (!xScale?.width) return;

    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const deltaSec = delta * ((xScale.max - xScale.min) / xScale.width);
    setChartViewEndSec(chartViewBounds().max + deltaSec, { followIfAtEnd: true });
  }, { passive: false });
}

function updateStatusCharts() {
  ['battery', 'temperature', 'storage'].forEach(updateMetricChart);

  const globalEmpty = document.getElementById('phone-status-charts-empty');
  if (globalEmpty) {
    const anyChart = ['battery', 'temperature', 'storage'].some(canDrawMetricChart);
    globalEmpty.hidden = anyChart || healthHistory.length === 0;
  }

  syncChartScrubber();
}

async function clearHealthHistory() {
  try {
    await apiFetch('/api/phone/history', { method: 'DELETE' });
    healthHistory = [];
    resetChartView();
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

function formatChargeControl(cc) {
  if (!cc) return '—';
  if (!cc.enabled) return 'Disabled in settings';

  const range = `${cc.startAt ?? 20}% → ${cc.stopAt ?? 80}%`;
  if (!cc.supported) {
    return cc.reason || 'Not supported (root may be required)';
  }

  const actionText = {
    disabled: 'Charging paused',
    enabled: 'Charging active',
    unchanged: 'Within limits',
    threshold_set: 'Hardware limits set',
    skipped: cc.reason || 'Skipped',
    error: `Error: ${cc.reason || 'unknown'}`,
  };

  const label = actionText[cc.action] || cc.action || 'Active';
  return `${label} · ${range}`;
}

function formatChargeControlSubtext(cc) {
  if (!cc?.enabled) return '';
  if (cc.plugged === false) return 'Cable unplugged';
  if (cc.level != null && cc.plugged) return `Battery ${cc.level}% · plugged in`;
  if (cc.mode && cc.mode !== 'unsupported') return `Mode: ${cc.mode}`;
  return '';
}

function renderChargeControlStatus() {
  const cc = health?.chargeControl;
  if (!cc) return '';

  const supported = cc.enabled && cc.supported;
  const badgeClass = !cc.enabled
    ? 'badge-muted'
    : supported
      ? (cc.action === 'disabled' ? 'badge-warning' : 'badge-success')
      : 'badge-muted';

  return `
    <div class="phone-charge-status card" id="phone-charge-status-card">
      <div class="recording-status-header">
        <h3 class="recording-section-title">Charge control</h3>
        <span class="badge ${badgeClass}" id="phone-charge-status-badge">
          ${cc.enabled ? (cc.supported ? 'Active' : 'Unsupported') : 'Off'}
        </span>
      </div>
      <p class="phone-charge-status-value" id="phone-charge-status-value">${escapeHtml(formatChargeControl(cc))}</p>
      <p class="phone-charge-status-sub" id="phone-charge-status-sub">${escapeHtml(formatChargeControlSubtext(cc))}</p>
    </div>`;
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

function renderMetric(label, value, {
  subtext = '',
  valueId = '',
  subtextId = '',
  level = null,
  statId = '',
} = {}) {
  const levelClass = level ? ` phone-health-stat--${level}` : '';
  return `
    <div class="recording-stat phone-health-stat${levelClass}"${statId ? ` id="${statId}"` : ''}>
      <span class="recording-stat-label">${escapeHtml(label)}</span>
      <span class="recording-stat-value"${valueId ? ` id="${valueId}"` : ''}>${escapeHtml(value)}</span>
      ${subtext || subtextId
        ? `<span class="phone-health-subtext phone-health-level-subtext"${subtextId ? ` id="${subtextId}"` : ''}>${escapeHtml(subtext)}</span>`
        : ''}
    </div>`;
}

function applyMetricLevel(statId, subtextId, level, subtext) {
  const stat = statId ? document.getElementById(statId) : null;
  if (stat) {
    stat.classList.remove('phone-health-stat--safe', 'phone-health-stat--warning', 'phone-health-stat--critical');
    if (level) stat.classList.add(`phone-health-stat--${level}`);
  }

  const sub = subtextId ? document.getElementById(subtextId) : null;
  if (sub) {
    sub.textContent = subtext || '';
    sub.hidden = !subtext;
  }
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
  const batteryLevel = evaluateBatteryLevel(health.battery?.level);
  const temperatureLevel = evaluateTemperatureLevel(health.battery?.temperatureCelsius);

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
          ${renderMetric('Battery', formatBattery(health.battery), {
            valueId: 'phone-status-battery',
            statId: 'phone-status-battery-stat',
            subtextId: 'phone-status-battery-level',
            subtext: batteryLevelSubtext(batteryLevel),
            level: batteryLevel,
          })}
          ${renderMetric('Temperature', formatTemperature(health.battery?.temperatureCelsius), {
            valueId: 'phone-status-temperature',
            statId: 'phone-status-temperature-stat',
            subtextId: 'phone-status-temperature-level',
            subtext: temperatureLevelSubtext(temperatureLevel),
            level: temperatureLevel,
          })}
          ${renderMetric('Storage', formatStorage(health.storage), {
            valueId: 'phone-status-storage',
            subtext: health.storage?.mount ? `Mount: ${health.storage.mount}` : '',
            subtextId: 'phone-status-storage-sub',
          })}
          ${renderMetric('Location', formatLocation(health.location), { valueId: 'phone-status-location' })}
        </div>

        <p class="phone-health-threshold-legend">
          <span class="phone-health-legend-item phone-health-legend-safe">Safe</span>
          <span class="phone-health-legend-item phone-health-legend-warning">Caution</span>
          <span class="phone-health-legend-item phone-health-legend-critical">Critical</span>
          <span class="phone-health-legend-ranges">
            Battery ${BATTERY_THRESHOLDS.safeMin}–${BATTERY_THRESHOLDS.safeMax}%
            · Temperature ${TEMPERATURE_THRESHOLDS.safeMin}–${TEMPERATURE_THRESHOLDS.safeMax}°C
          </span>
        </p>

        <p class="phone-health-updated" id="phone-status-updated">
          Last updated: ${health.fetchedAt ? new Date(health.fetchedAt).toLocaleTimeString() : '—'}
        </p>

        ${renderWarnings()}
      </div>

      ${renderChargeControlStatus()}

      <div class="card phone-health-chart-card">
        <div class="recording-status-header">
          <h3 class="recording-section-title">Status history</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="phone-status-clear-chart">Clear graphs</button>
        </div>
        <p class="phone-health-chart-hint">
          Showing the last 6 hours
          ${healthHistory.length ? ` · ${healthHistory.length} sample${healthHistory.length === 1 ? '' : 's'}` : ''}
          · up to ${CHART_HISTORY_DAYS} days retained.
          Drag a graph or use the slider to scroll earlier. Keep this tab open with auto-refresh (or open it daily) so samples accumulate.
        </p>
        <p class="phone-health-chart-hint" id="phone-status-charts-empty" hidden>
          Refresh at least twice to start building graphs. Enable auto-refresh or press Refresh now.
        </p>
        <div class="phone-status-charts-grid">
          ${renderMetricChartCard('battery', 'Battery', 'Need at least two battery readings.')}
          ${renderMetricChartCard('temperature', 'Temperature', 'Need at least two temperature readings.')}
          ${renderMetricChartCard('storage', 'Storage', 'Need at least two storage readings.')}
        </div>
        <div class="phone-status-chart-scrubber" id="phone-status-chart-scrubber" hidden>
          <span class="phone-status-chart-scrubber-label">Earlier</span>
          <input
            type="range"
            id="phone-status-chart-range"
            class="phone-status-chart-range"
            min="0"
            max="0"
            value="0"
            aria-label="Scroll status history"
          >
          <span class="phone-status-chart-scrubber-label">Latest</span>
          <button type="button" class="btn btn-ghost btn-sm" id="phone-status-chart-latest" disabled>
            Jump to latest
          </button>
        </div>
      </div>
    </div>`;
}

function updateHealthDisplay() {
  if (!health) return;

  const batteryLevel = evaluateBatteryLevel(health.battery?.level);
  const temperatureLevel = evaluateTemperatureLevel(health.battery?.temperatureCelsius);

  const battery = document.getElementById('phone-status-battery');
  if (battery) battery.textContent = formatBattery(health.battery);
  applyMetricLevel(
    'phone-status-battery-stat',
    'phone-status-battery-level',
    batteryLevel,
    batteryLevelSubtext(batteryLevel),
  );

  const temperature = document.getElementById('phone-status-temperature');
  if (temperature) temperature.textContent = formatTemperature(health.battery?.temperatureCelsius);
  applyMetricLevel(
    'phone-status-temperature-stat',
    'phone-status-temperature-level',
    temperatureLevel,
    temperatureLevelSubtext(temperatureLevel),
  );

  const storage = document.getElementById('phone-status-storage');
  if (storage) storage.textContent = formatStorage(health.storage);

  const storageSub = document.getElementById('phone-status-storage-sub');
  if (storageSub) {
    storageSub.textContent = health.storage?.mount ? `Mount: ${health.storage.mount}` : '';
    storageSub.hidden = !health.storage?.mount;
  }

  const location = document.getElementById('phone-status-location');
  if (location) location.textContent = formatLocation(health.location);

  const chargeValue = document.getElementById('phone-charge-status-value');
  if (chargeValue) chargeValue.textContent = formatChargeControl(health.chargeControl);

  const chargeSub = document.getElementById('phone-charge-status-sub');
  if (chargeSub) chargeSub.textContent = formatChargeControlSubtext(health.chargeControl);

  const chargeBadge = document.getElementById('phone-charge-status-badge');
  const cc = health.chargeControl;
  if (chargeBadge && cc) {
    const supported = cc.enabled && cc.supported;
    chargeBadge.className = `badge ${
      !cc.enabled
        ? 'badge-muted'
        : supported
          ? (cc.action === 'disabled' ? 'badge-warning' : 'badge-success')
          : 'badge-muted'
    }`;
    chargeBadge.textContent = cc.enabled ? (cc.supported ? 'Active' : 'Unsupported') : 'Off';
  }

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

  const range = document.getElementById('phone-status-chart-range');
  range?.addEventListener('input', (e) => {
    const startSec = Number(e.target.value);
    if (!Number.isFinite(startSec)) return;
    setChartViewEndSec(startSec + chartViewWindowSeconds(), { followIfAtEnd: true });
  });

  document.getElementById('phone-status-chart-latest')?.addEventListener('click', () => {
    jumpChartToLatest();
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
    const query = [
      `refreshIntervalSec=${encodeURIComponent(interval)}`,
      `historyDays=${CHART_HISTORY_DAYS}`,
    ].join('&');
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
