import { apiFetch, parseFilenameDate, showToast } from './utils.js';
import { normalizeResultForAnalytics } from './mealResults.js';

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
  const calorieTimeline = {};
  const confidenceCounts = { High: 0, Medium: 0, Low: 0 };
  const macroTotals = { protein: 0, carbs: 0, fat: 0, count: 0 };

  for (const [filename, result] of entries) {
    const normalized = normalizeResultForAnalytics(result);
    const date = parseFilenameDate(filename) || new Date(result.processedAt);
    const dateKey = date.toISOString().split('T')[0];

    if (normalized.type === 'meal' && normalized.totals) {
      calorieTimeline[dateKey] = (calorieTimeline[dateKey] || 0) + (normalized.totals.calories || 0);
      macroTotals.protein += normalized.totals.protein_g || 0;
      macroTotals.carbs += normalized.totals.carbs_total_g || 0;
      macroTotals.fat += normalized.totals.fat_total_g || 0;
      macroTotals.count += 1;

      const conf = normalized.confidence || 'Low';
      if (confidenceCounts[conf] !== undefined) {
        confidenceCounts[conf] += 1;
      } else {
        confidenceCounts.Low += 1;
      }
    }

    for (const item of normalized.items) {
      const name = item.name;
      if (name) foodFreq[name] = (foodFreq[name] || 0) + 1;
    }
  }

  const macroAverages = macroTotals.count
    ? {
        protein: macroTotals.protein / macroTotals.count,
        carbs: macroTotals.carbs / macroTotals.count,
        fat: macroTotals.fat / macroTotals.count,
      }
    : { protein: 0, carbs: 0, fat: 0 };

  return { entries, foodFreq, calorieTimeline, confidenceCounts, macroAverages };
}

function computeStats(agg) {
  const { entries, foodFreq, calorieTimeline } = agg;
  const foods = Object.keys(foodFreq);
  const mostCommon = foods.sort((a, b) => foodFreq[b] - foodFreq[a])[0] || '—';
  const dates = Object.keys(calorieTimeline).sort();
  const totalCalories = Object.values(calorieTimeline).reduce((s, v) => s + v, 0);

  return {
    totalMeals: entries.length,
    uniqueFoods: foods.length,
    mostCommon,
    totalCalories: Math.round(totalCalories),
    dateRange: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—',
  };
}

function renderStats(stats) {
  return `
    <div class="stats-grid">
      <div class="card stat-card glass">
        <div class="stat-value">${stats.totalMeals}</div>
        <div class="stat-label">Meals Processed</div>
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
        <div class="stat-value">${stats.totalCalories}</div>
        <div class="stat-label">Total Calories</div>
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
        <h3>Calorie Timeline</h3>
        <div class="chart-container"><canvas id="chart-calories"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Average Macros per Meal</h3>
        <div class="chart-container"><canvas id="chart-macros"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Confidence Breakdown</h3>
        <div class="chart-container"><canvas id="chart-confidence"></canvas></div>
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

function createCalorieChart(calorieTimeline) {
  const sorted = Object.entries(calorieTimeline).sort((a, b) => a[0].localeCompare(b[0]));
  const ctx = document.getElementById('chart-calories');
  if (!ctx || sorted.length === 0) return;

  charts.push(new Chart(ctx, {
    type: 'line',
    data: {
      labels: sorted.map(([d]) => d),
      datasets: [{
        label: 'Calories (kcal)',
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

function createMacroChart(macroAverages) {
  const ctx = document.getElementById('chart-macros');
  if (!ctx || !macroAverages) return;

  charts.push(new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Protein', 'Carbs', 'Fat'],
      datasets: [{
        label: 'Grams (avg)',
        data: [
          macroAverages.protein,
          macroAverages.carbs,
          macroAverages.fat,
        ],
        backgroundColor: [ACCENT_COLORS[0], ACCENT_COLORS[1], ACCENT_COLORS[3]],
        borderRadius: 6,
      }],
    },
    options: chartOptions(),
  }));
}

function createConfidenceChart(confidenceCounts) {
  const ctx = document.getElementById('chart-confidence');
  if (!ctx) return;

  const total = Object.values(confidenceCounts).reduce((s, v) => s + v, 0);
  if (total === 0) return;

  charts.push(new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['High', 'Medium', 'Low'],
      datasets: [{
        data: [confidenceCounts.High, confidenceCounts.Medium, confidenceCounts.Low],
        backgroundColor: ['#059669', '#d97706', '#dc2626'],
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
  createCalorieChart(agg.calorieTimeline);
  createMacroChart(agg.macroAverages);
  createConfidenceChart(agg.confidenceCounts);
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
