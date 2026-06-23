import { apiFetch, parseFilenameDate, showToast } from './utils.js';
import { normalizeResultForAnalytics, formatWeight } from './mealResults.js';

let results = {};
let charts = [];

const ACCENT_COLORS = ['#6b5ce7', '#e85d8a', '#0d9488', '#d97706', '#dc2626', '#0891b2'];
const CHART_TEXT = '#475569';
const CHART_GRID = 'rgba(0, 0, 0, 0.06)';

const container = () => document.getElementById('analytics-content');

function destroyCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];
}

function computeAggregates() {
  const entries = Object.entries(results);
  const foodFreq = {};
  const weightTimeline = {};
  const typeCounts = { food: 0, legacy: 0, macro: 0 };
  let compositeItems = 0;

  for (const [filename, result] of entries) {
    const normalized = normalizeResultForAnalytics(result);
    const date = parseFilenameDate(filename) || new Date(result.processedAt);
    const dateKey = date.toISOString().split('T')[0];

    typeCounts[normalized.type] = (typeCounts[normalized.type] || 0) + 1;

    if (normalized.type === 'food' && normalized.totalWeight) {
      weightTimeline[dateKey] = (weightTimeline[dateKey] || 0) + normalized.totalWeight;
    }

    for (const item of normalized.items) {
      const name = item.name;
      if (name) foodFreq[name] = (foodFreq[name] || 0) + 1;
      if (item.is_composite) compositeItems += 1;
    }
  }

  return { entries, foodFreq, weightTimeline, typeCounts, compositeItems };
}

function computeStats(agg) {
  const { entries, foodFreq, weightTimeline, compositeItems } = agg;
  const foods = Object.keys(foodFreq);
  const mostCommon = foods.sort((a, b) => foodFreq[b] - foodFreq[a])[0] || '—';
  const dates = Object.keys(weightTimeline).sort();
  const totalWeight = Object.values(weightTimeline).reduce((s, v) => s + v, 0);

  return {
    totalMeals: entries.length,
    uniqueFoods: foods.length,
    mostCommon,
    totalWeight: formatWeight(totalWeight),
    compositeItems,
    dateRange: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—',
  };
}

function renderStats(stats) {
  return `
    <div class="stats-grid">
      <div class="card stat-card glass">
        <div class="stat-value">${stats.totalMeals}</div>
        <div class="stat-label">Photos Processed</div>
      </div>
      <div class="card stat-card glass">
        <div class="stat-value">${stats.uniqueFoods}</div>
        <div class="stat-label">Unique Foods</div>
      </div>
      <div class="card stat-card glass">
        <div class="stat-value" style="font-size: 1.25rem;">${stats.mostCommon}</div>
        <div class="stat-label">Most Common Item</div>
      </div>
      <div class="card stat-card glass">
        <div class="stat-value" style="font-size: 1.25rem;">${stats.totalWeight}</div>
        <div class="stat-label">Total Visible Weight</div>
      </div>
    </div>`;
}

function renderCharts() {
  return `
    <div class="charts-grid">
      <div class="card chart-card glass">
        <h3>Most Frequent Foods</h3>
        <div class="chart-container"><canvas id="chart-foods"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Estimated Weight Timeline</h3>
        <div class="chart-container"><canvas id="chart-weight"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Result Format Mix</h3>
        <div class="chart-container"><canvas id="chart-formats"></canvas></div>
      </div>
    </div>`;
}

function chartOptions(legend = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 800 },
    plugins: { legend: { display: legend, labels: { color: CHART_TEXT } } },
    scales: {
      y: { beginAtZero: true, ticks: { color: CHART_TEXT }, grid: { color: CHART_GRID } },
      x: { ticks: { color: CHART_TEXT }, grid: { display: false } },
    },
  };
}

function createFoodChart(foodFreq) {
  const sorted = Object.entries(foodFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const ctx = document.getElementById('chart-foods');
  if (!ctx || sorted.length === 0) return;

  charts.push(new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(([k]) => k),
      datasets: [{
        label: 'Count',
        data: sorted.map(([, v]) => v),
        backgroundColor: ACCENT_COLORS[0],
        borderRadius: 6,
      }],
    },
    options: chartOptions(),
  }));
}

function createWeightChart(weightTimeline) {
  const sorted = Object.entries(weightTimeline).sort((a, b) => a[0].localeCompare(b[0]));
  const ctx = document.getElementById('chart-weight');
  if (!ctx || sorted.length === 0) return;

  charts.push(new Chart(ctx, {
    type: 'line',
    data: {
      labels: sorted.map(([d]) => d),
      datasets: [{
        label: 'Visible weight (g)',
        data: sorted.map(([, v]) => Math.round(v)),
        borderColor: ACCENT_COLORS[2],
        backgroundColor: 'rgba(13, 148, 136, 0.12)',
        fill: true,
        tension: 0.3,
      }],
    },
    options: chartOptions(true),
  }));
}

function createFormatChart(typeCounts) {
  const ctx = document.getElementById('chart-formats');
  if (!ctx) return;

  const data = [
    typeCounts.food || 0,
    typeCounts.macro || 0,
    typeCounts.legacy || 0,
  ];
  if (data.every((value) => value === 0)) return;

  charts.push(new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Food recognition', 'Legacy macros', 'Legacy zones'],
      datasets: [{
        data,
        backgroundColor: ['#059669', '#d97706', '#64748b'],
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800 },
      plugins: { legend: { labels: { color: CHART_TEXT } } },
    },
  }));
}

function exportResults() {
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'smartdining-results.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Results exported', 'success');
}

function render() {
  destroyCharts();

  const entries = Object.keys(results);
  if (entries.length === 0) {
    container().innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <h3>No analytics data yet</h3>
        <p>Process some meal photos first to see analytics here.</p>
      </div>`;
    return;
  }

  const agg = computeAggregates();
  const stats = computeStats(agg);

  container().innerHTML = `
    ${renderStats(stats)}
    <div class="analytics-actions">
      <button class="btn btn-primary" id="export-btn">Export Results JSON</button>
    </div>
    ${renderCharts()}`;

  document.getElementById('export-btn')?.addEventListener('click', exportResults);

  createFoodChart(agg.foodFreq);
  createWeightChart(agg.weightTimeline);
  createFormatChart(agg.typeCounts);
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    results = await apiFetch('/api/results');
    render();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <h3>Failed to load analytics</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}
