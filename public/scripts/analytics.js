import { apiFetch, parseFilenameDate, showToast } from './utils.js';

let results = {};
let charts = [];

const ACCENT_COLORS = ['#7c6ff7', '#f76f9b', '#6ff7c8', '#ffd166', '#ff6b6b', '#4ecdc4'];

const container = () => document.getElementById('analytics-content');

function destroyCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];
}

function computeAggregates() {
  const entries = Object.entries(results);
  const foodFreq = {};
  const ingredientFreq = {};
  const seatFoods = {};
  const timeline = {};

  for (const [filename, result] of entries) {
    const date = parseFilenameDate(filename) || new Date(result.processedAt);
    const dateKey = date.toISOString().split('T')[0];
    timeline[dateKey] = (timeline[dateKey] || 0) + 1;

    for (const zone of result.zones || []) {
      const seatName = zone.name;
      if (!seatFoods[seatName]) seatFoods[seatName] = {};

      for (const food of zone.foods || []) {
        foodFreq[food.item] = (foodFreq[food.item] || 0) + 1;
        seatFoods[seatName][food.item] = (seatFoods[seatName][food.item] || 0) + 1;

        for (const ing of food.ingredients || []) {
          ingredientFreq[ing] = (ingredientFreq[ing] || 0) + 1;
        }
      }
    }
  }

  return { entries, foodFreq, ingredientFreq, seatFoods, timeline };
}

function computeStats(agg) {
  const { entries, foodFreq, timeline } = agg;
  const foods = Object.keys(foodFreq);
  const mostCommon = foods.sort((a, b) => foodFreq[b] - foodFreq[a])[0] || '—';
  const dates = Object.keys(timeline).sort();

  return {
    totalMeals: entries.length,
    uniqueFoods: foods.length,
    mostCommon,
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
        <div class="stat-value" style="font-size: 0.9rem;">${stats.dateRange}</div>
        <div class="stat-label">Date Range</div>
      </div>
    </div>`;
}

function renderCharts(agg) {
  return `
    <div class="charts-grid">
      <div class="card chart-card glass">
        <h3>Most Frequent Foods</h3>
        <div class="chart-container"><canvas id="chart-foods"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Per-Seat Breakdown</h3>
        <div class="chart-container"><canvas id="chart-seats"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Meal Timeline</h3>
        <div class="chart-container"><canvas id="chart-timeline"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Ingredient Frequency</h3>
        <div class="chart-container"><canvas id="chart-ingredients"></canvas></div>
      </div>
    </div>`;
}

function createFoodChart(foodFreq) {
  const sorted = Object.entries(foodFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const ctx = document.getElementById('chart-foods');
  if (!ctx) return;

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
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800 },
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { color: '#e8e8f0' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        x: { ticks: { color: '#e8e8f0' }, grid: { display: false } },
      },
    },
  }));
}

function createSeatChart(seatFoods) {
  const seats = Object.keys(seatFoods);
  const allFoods = [...new Set(seats.flatMap((s) => Object.keys(seatFoods[s])))].slice(0, 8);
  const ctx = document.getElementById('chart-seats');
  if (!ctx || seats.length === 0) return;

  charts.push(new Chart(ctx, {
    type: 'bar',
    data: {
      labels: allFoods,
      datasets: seats.map((seat, i) => ({
        label: seat,
        data: allFoods.map((f) => seatFoods[seat][f] || 0),
        backgroundColor: ACCENT_COLORS[i % ACCENT_COLORS.length],
        borderRadius: 4,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800 },
      plugins: { legend: { labels: { color: '#e8e8f0' } } },
      scales: {
        y: { beginAtZero: true, ticks: { color: '#e8e8f0' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        x: { ticks: { color: '#e8e8f0' }, grid: { display: false } },
      },
    },
  }));
}

function createTimelineChart(timeline) {
  const sorted = Object.entries(timeline).sort((a, b) => a[0].localeCompare(b[0]));
  const ctx = document.getElementById('chart-timeline');
  if (!ctx || sorted.length === 0) return;

  charts.push(new Chart(ctx, {
    type: 'line',
    data: {
      labels: sorted.map(([d]) => d),
      datasets: [{
        label: 'Meals',
        data: sorted.map(([, v]) => v),
        borderColor: ACCENT_COLORS[2],
        backgroundColor: 'rgba(111, 247, 200, 0.1)',
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800 },
      plugins: { legend: { labels: { color: '#e8e8f0' } } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1, color: '#e8e8f0' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        x: { ticks: { color: '#e8e8f0' }, grid: { display: false } },
      },
    },
  }));
}

function createIngredientChart(ingredientFreq) {
  const sorted = Object.entries(ingredientFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const ctx = document.getElementById('chart-ingredients');
  if (!ctx) return;

  charts.push(new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(([k]) => k),
      datasets: [{
        label: 'Count',
        data: sorted.map(([, v]) => v),
        backgroundColor: ACCENT_COLORS[1],
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800 },
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { color: '#e8e8f0' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#e8e8f0' }, grid: { display: false } },
      },
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
    ${renderCharts(agg)}`;

  document.getElementById('export-btn')?.addEventListener('click', exportResults);

  createFoodChart(agg.foodFreq);
  createSeatChart(agg.seatFoods);
  createTimelineChart(agg.timeline);
  createIngredientChart(agg.ingredientFreq);
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
