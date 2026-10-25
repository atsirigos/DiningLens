import { apiFetch, parseFilenameDate, parseSessionStart, formatFriendlyDateTime, formatDate, showToast } from './utils.js';
import { normalizeResultForAnalytics, formatWeight, renderMealSummary } from './mealResults.js';

let results = {};
let foodTaxonomy = { entries: {} };
let charts = [];
let foodsExpanded = false;
let mealById = new Map();
let mealPopout = null;
let mealPopoutAnchor = null;
let mealPopoutListenersBound = false;

const FOODS_COLLAPSED = 20;

const FOOD_CATEGORY_RULES = [
  ['Drinks', /\b(waters?|coffees?|teas?|juices?|sodas?|wines?|beers?)\b/],
  ['Oils & fats', /\b(olive oil|butters?|oils?)\b/],
  ['Dairy', /\b(cheeses?|yogurts?|yoghurts?|tzatziki|milks?)\b/],
  ['Other', /\b(vinegars?|dips?|sauces?|chips?|ketchups?|mayonnaises?|mayo)\b/],
  ['Grains', /\b(breads?|pastas?|spaghetti|penne|fusilli|fettuccine|rices?|tortillas?|crackers?|oatcakes?|oats?|grains?|noodles?|rye)\b/],
  ['Protein', /\b(chicken|beefs?|beef|meats?|meatballs?|patt(?:y|ies)|fish|eggs?|lentils?|chickpeas?|hummus|turkeys?|porks?|pork|tofu|shrimps?|salmons?|tunas?)\b/],
  ['Fruits', /\b(lemons?|limes?|avocados?|watermelons?|citrus|loquats?|strawberr(?:y|ies)|apples?|bananas?|oranges?|fruits?|berr(?:y|ies)|grapes?|melons?)\b/],
  ['Vegetables', /\b(tomato(?:es)?|potato(?:es)?|salads?|greens?|arugula|spinach(?:es)?|cucumbers?|basil|onions?|cauliflowers?|cabbages?|beets?|lettuces?|broccolis?|carrots?|peppers?|chards?|seaweeds?|scallions?|vegetables?|beans?|olives?)\b/],
];

const CATEGORY_COLORS = {
  Vegetables: '#3dbea8',
  Fruits: '#f26d9a',
  Grains: '#f0b429',
  Protein: '#7b6cf6',
  Dairy: '#c084fc',
  Drinks: '#3eb8e5',
  'Oils & fats': '#ff8c61',
  Other: '#a8b3c4',
};

function normalizeFoodName(name) {
  return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function foodCategory(name) {
  const normalized = normalizeFoodName(name);
  for (const [category, pattern] of FOOD_CATEGORY_RULES) {
    if (pattern.test(normalized)) return category;
  }
  return 'Other';
}

function mapFood(rawName) {
  const entry = foodTaxonomy?.entries?.[rawName];
  if (entry?.canonical) {
    const category = CATEGORY_COLORS[entry.category] ? entry.category : foodCategory(entry.canonical);
    return { canonical: entry.canonical, category };
  }
  return { canonical: rawName, category: foodCategory(rawName) };
}

function categoryCounts(foodFreq, categoryByFood) {
  const counts = {};
  for (const [name, count] of Object.entries(foodFreq)) {
    const category = categoryByFood[name] || 'Other';
    counts[category] = (counts[category] || 0) + count;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}
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
  const categoryVotes = {};
  const weightTimeline = {};
  let compositeItems = 0;

  for (const [filename, result] of entries) {
    const normalized = normalizeResultForAnalytics(result);
    const date = parseFilenameDate(filename) || new Date(result.processedAt);
    const dateKey = date.toISOString().split('T')[0];

    if (normalized.type === 'food' && normalized.totalWeight) {
      weightTimeline[dateKey] = (weightTimeline[dateKey] || 0) + normalized.totalWeight;
    }

    for (const item of normalized.items) {
      if (!item.name) continue;
      const mapped = mapFood(item.name);
      foodFreq[mapped.canonical] = (foodFreq[mapped.canonical] || 0) + 1;
      const votes = categoryVotes[mapped.canonical] || (categoryVotes[mapped.canonical] = {});
      votes[mapped.category] = (votes[mapped.category] || 0) + 1;
      if (item.is_composite) compositeItems += 1;
    }
  }

  const categoryByFood = {};
  for (const [name, votes] of Object.entries(categoryVotes)) {
    categoryByFood[name] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  }

  return { entries, foodFreq, categoryByFood, weightTimeline, compositeItems };
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mealInstant(filename, result) {
  const base = String(filename).split(/[/\\]/).pop();
  const fromFile = parseFilenameDate(base);
  if (fromFile && !Number.isNaN(fromFile.getTime())) return fromFile;

  const sessionMatch = String(filename).match(/(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
  const fromSession = sessionMatch ? parseSessionStart(sessionMatch[1]) : null;
  if (fromSession) return fromSession;

  const processed = new Date(result?.processedAt);
  return Number.isNaN(processed.getTime()) ? null : processed;
}

function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function hourLabel(hour) {
  const suffix = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}${suffix}`;
}

function collectMeals(entries) {
  const meals = [];
  for (const [filename, result] of entries) {
    const when = mealInstant(filename, result);
    if (!when) continue;
    const normalized = normalizeResultForAnalytics(result);
    const foods = normalized.items.map((item) => item.name).filter(Boolean);
    meals.push({ when, foods, filename, result });
  }
  meals.sort((a, b) => a.when - b.when);
  meals.forEach((meal, index) => {
    meal.id = String(index);
  });
  mealById = new Map(meals.map((meal) => [meal.id, meal]));
  return meals;
}

function renderMealCalendar(entries) {
  const meals = collectMeals(entries);
  if (meals.length === 0) return '';

  const minHour = Math.min(...meals.map((meal) => meal.when.getHours()));
  const maxHour = Math.max(...meals.map((meal) => meal.when.getHours()));
  const hours = [];
  for (let hour = minHour; hour <= maxHour; hour += 1) hours.push(hour);

  const byDate = new Map();
  for (const meal of meals) {
    const key = localDateKey(meal.when);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(meal);
  }

  const dates = [...byDate.keys()].sort();
  let previousMonth = null;

  const rows = dates.map((key) => {
    const dayMeals = byDate.get(key);
    const sample = dayMeals[0].when;
    const monthStart = previousMonth !== null && sample.getMonth() !== previousMonth;
    previousMonth = sample.getMonth();
    const weekend = sample.getDay() === 0 || sample.getDay() === 6;
    const rowClass = [
      weekend ? 'is-weekend' : '',
      monthStart ? 'is-month-start' : '',
    ].filter(Boolean).join(' ');

    const cells = hours.map((hour) => {
      const inHour = dayMeals.filter((meal) => meal.when.getHours() === hour);
      if (inHour.length === 0) return '<td class="meal-calendar-cell"></td>';

      const dots = inHour.map((meal) => {
        const foodText = meal.foods.slice(0, 4).join(', ');
        const extra = meal.foods.length > 4 ? '…' : '';
        const detail = foodText ? `${foodText}${extra}` : 'Meal';
        const label = `${formatFriendlyDateTime(meal.when)} — ${detail}`;
        const minuteFraction = (meal.when.getMinutes() * 60 + meal.when.getSeconds()) / 3600;
        const sameTime = inHour.filter((other) => (
          other.when.getMinutes() === meal.when.getMinutes()
          && other.when.getSeconds() === meal.when.getSeconds()
        ));
        const stack = sameTime.indexOf(meal);
        const top = 50 + (stack - (sameTime.length - 1) / 2) * 14;
        return `<button type="button" class="meal-dot" data-meal-id="${meal.id}" style="left: ${(minuteFraction * 100).toFixed(2)}%; top: ${top}%" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" aria-haspopup="dialog" aria-expanded="false"></button>`;
      }).join('');

      return `<td class="meal-calendar-cell">${dots}</td>`;
    }).join('');

    const dateLabel = `${WEEKDAYS[sample.getDay()]}, ${MONTHS[sample.getMonth()]} ${sample.getDate()}`;
    return `<tr class="${rowClass}"><th class="meal-calendar-date" scope="row">${dateLabel}</th>${cells}</tr>`;
  }).join('');

  const head = hours.map((hour) => `<th scope="col">${hourLabel(hour)}</th>`).join('');

  return `
    <div class="card chart-card glass meal-calendar-card">
      <h3>Meal Calendar</h3>
      <div class="meal-calendar-scroll">
        <table class="meal-calendar">
          <caption class="sr-only">Meal calendar. Each row is a date, each column is an hour, and each dot is a meal.</caption>
          <thead>
            <tr>
              <th class="meal-calendar-date" scope="col">Date</th>
              ${head}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function mealSourceLabel(filename) {
  const parts = String(filename).split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join(' / ') || String(filename);
}

function renderMealFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return '';
  const items = frames.map((frame) => {
    const name = String(frame.file || '').split(/[/\\]/).pop() || 'frame';
    const time = Number.isFinite(Number(frame.timeSec)) ? `${Number(frame.timeSec).toFixed(1)}s` : '';
    return `<li>${escapeHtml(time ? `${name} · ${time}` : name)}</li>`;
  }).join('');
  return `
    <details class="meal-popout-frames">
      <summary>${frames.length} source frame${frames.length === 1 ? '' : 's'}</summary>
      <ul>${items}</ul>
    </details>`;
}

function renderMealPopout(meal) {
  const { result } = meal;
  const meta = [];
  if (result.processedAt) meta.push(`<span><strong>Processed</strong> ${escapeHtml(formatDate(result.processedAt))}</span>`);
  if (result.mediaType) meta.push(`<span><strong>Media</strong> ${escapeHtml(result.mediaType)}</span>`);
  if (result.captureMode) meta.push(`<span><strong>Capture</strong> ${escapeHtml(result.captureMode)}</span>`);
  if (result.frameTimeSec != null && Number.isFinite(Number(result.frameTimeSec))) {
    meta.push(`<span><strong>Frame</strong> ${Number(result.frameTimeSec).toFixed(1)}s</span>`);
  }
  if (result.frameCount) meta.push(`<span><strong>Frames</strong> ${escapeHtml(result.frameCount)}</span>`);
  if (result.sourceCount) meta.push(`<span><strong>Sources</strong> ${escapeHtml(result.sourceCount)}</span>`);

  return `
    <div class="meal-popout" role="dialog" aria-modal="false" aria-labelledby="meal-popout-title">
      <div class="meal-popout-header">
        <div>
          <h3 id="meal-popout-title">${escapeHtml(formatFriendlyDateTime(meal.when))}</h3>
          <p class="meal-popout-file">${escapeHtml(mealSourceLabel(meal.filename))}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm meal-popout-close" aria-label="Close">✕</button>
      </div>
      <div class="meal-popout-body">
        ${meta.length ? `<div class="meal-popout-meta">${meta.join('')}</div>` : ''}
        ${renderMealFrames(result.frames)}
        ${renderMealSummary(result)}
      </div>
    </div>`;
}

function anchorVisible(anchor) {
  const rect = anchor.getBoundingClientRect();
  const scroll = anchor.closest('.meal-calendar-scroll');
  const bounds = scroll ? scroll.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  return rect.bottom > bounds.top
    && rect.top < bounds.bottom
    && rect.right > bounds.left
    && rect.left < bounds.right;
}

function placeMealPopout() {
  if (!mealPopout || !mealPopoutAnchor) return;
  if (!mealPopoutAnchor.isConnected || !anchorVisible(mealPopoutAnchor)) {
    closeMealPopout({ restoreFocus: false });
    return;
  }

  const margin = 12;
  const rect = mealPopoutAnchor.getBoundingClientRect();
  const pop = mealPopout.getBoundingClientRect();
  let left = rect.right + margin;
  if (left + pop.width > window.innerWidth - margin) left = rect.left - pop.width - margin;
  left = Math.max(margin, Math.min(left, window.innerWidth - pop.width - margin));

  let top = rect.top - 8;
  if (top + pop.height > window.innerHeight - margin) top = window.innerHeight - pop.height - margin;
  top = Math.max(margin, top);

  mealPopout.style.left = `${left}px`;
  mealPopout.style.top = `${top}px`;
}

function closeMealPopout({ restoreFocus = true } = {}) {
  mealPopout?.remove();
  mealPopout = null;
  if (!mealPopoutAnchor) return;
  mealPopoutAnchor.classList.remove('is-open');
  mealPopoutAnchor.setAttribute('aria-expanded', 'false');
  const anchor = mealPopoutAnchor;
  mealPopoutAnchor = null;
  if (restoreFocus && anchor.isConnected) anchor.focus();
}

function openMealPopout(anchor) {
  const meal = mealById.get(anchor.dataset.mealId);
  if (!meal) return;
  closeMealPopout({ restoreFocus: false });

  const holder = document.createElement('div');
  holder.innerHTML = renderMealPopout(meal);
  mealPopout = holder.firstElementChild;
  mealPopout.style.visibility = 'hidden';
  document.body.appendChild(mealPopout);
  mealPopoutAnchor = anchor;
  anchor.classList.add('is-open');
  anchor.setAttribute('aria-expanded', 'true');
  placeMealPopout();
  if (mealPopout) mealPopout.style.visibility = 'visible';
  mealPopout?.querySelector('.meal-popout-close')?.addEventListener('click', () => closeMealPopout());
}

function bindMealPopoutListeners() {
  if (mealPopoutListenersBound) return;
  mealPopoutListenersBound = true;

  document.addEventListener('click', (event) => {
    if (!mealPopout) return;
    if (mealPopout.contains(event.target)) return;
    if (event.target.closest?.('.meal-dot')) return;
    closeMealPopout({ restoreFocus: false });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mealPopout) {
      event.preventDefault();
      closeMealPopout();
    }
  });

  document.addEventListener('scroll', () => {
    if (mealPopoutAnchor) placeMealPopout();
  }, true);

  window.addEventListener('resize', () => {
    if (mealPopoutAnchor) placeMealPopout();
  });
}

function bindMealCalendar() {
  bindMealPopoutListeners();
  document.querySelector('.meal-calendar')?.addEventListener('click', (event) => {
    const dot = event.target.closest('.meal-dot');
    if (!dot) return;
    event.stopPropagation();
    if (mealPopoutAnchor === dot) {
      closeMealPopout();
      return;
    }
    openMealPopout(dot);
  });
}

function renderCharts() {
  return `
    <div class="charts-grid">
      <div class="card chart-card glass">
        <div class="chart-card-header">
          <h3>Most Frequent Foods &amp; Drinks <span class="chart-card-count" id="foods-count"></span></h3>
          <button type="button" class="btn btn-ghost" id="foods-expand-btn" hidden>Show all</button>
        </div>
        <div class="chart-container chart-container-foods" id="chart-foods-wrap"><canvas id="chart-foods"></canvas></div>
      </div>
      <div class="card chart-card glass">
        <h3>Main Food Categories</h3>
        <div class="chart-container chart-container-categories"><canvas id="chart-categories"></canvas></div>
      </div>
    </div>`;
}

function foodChartOptions() {
  return {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 600 },
    plugins: { legend: { display: false } },
    scales: {
      x: {
        beginAtZero: true,
        ticks: { color: CHART_TEXT, precision: 0 },
        grid: { color: CHART_GRID },
      },
      y: {
        ticks: {
          color: CHART_TEXT,
          autoSkip: false,
          callback(value) {
            const label = this.getLabelForValue(value);
            return label.length > 42 ? `${label.slice(0, 40)}…` : label;
          },
        },
        grid: { display: false },
      },
    },
  };
}

function rankedFoods(foodFreq) {
  return Object.entries(foodFreq).sort((a, b) => b[1] - a[1]);
}

function updateFoodsToggle(total) {
  const count = document.getElementById('foods-count');
  const btn = document.getElementById('foods-expand-btn');
  const shown = foodsExpanded ? total : Math.min(FOODS_COLLAPSED, total);
  if (count) count.textContent = total > shown ? `${shown} of ${total}` : '';
  if (!btn) return;
  const canExpand = total > FOODS_COLLAPSED;
  btn.hidden = !canExpand;
  btn.textContent = foodsExpanded ? `Show top ${FOODS_COLLAPSED}` : `Show all ${total}`;
  btn.setAttribute('aria-expanded', String(foodsExpanded));
}

function createFoodChart(foodFreq, categoryByFood) {
  const sorted = rankedFoods(foodFreq);
  const visible = foodsExpanded ? sorted : sorted.slice(0, FOODS_COLLAPSED);
  const wrap = document.getElementById('chart-foods-wrap');
  const ctx = document.getElementById('chart-foods');
  updateFoodsToggle(sorted.length);
  if (!ctx || !wrap || visible.length === 0) return;

  wrap.style.height = `${Math.max(280, visible.length * 28 + 36)}px`;

  charts.push(new Chart(ctx, {
    type: 'bar',
    data: {
      labels: visible.map(([name]) => name),
      datasets: [{
        label: 'Count',
        data: visible.map(([, count]) => count),
        backgroundColor: visible.map(([name]) => CATEGORY_COLORS[categoryByFood[name]] || CATEGORY_COLORS.Other),
        borderRadius: 6,
        maxBarThickness: 16,
      }],
    },
    options: foodChartOptions(),
  }));
}

function createCategoryChart(foodFreq, categoryByFood) {
  const ranked = categoryCounts(foodFreq, categoryByFood);
  const ctx = document.getElementById('chart-categories');
  if (!ctx || ranked.length === 0) return;

  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  charts.push(new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ranked.map(([category]) => category),
      datasets: [{
        data: ranked.map(([, count]) => count),
        backgroundColor: ranked.map(([category]) => CATEGORY_COLORS[category] || CATEGORY_COLORS.Other),
        borderWidth: 0,
        borderRadius: 8,
        spacing: 3,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      animation: { duration: 600 },
      plugins: {
        legend: {
          position: 'right',
          align: 'center',
          labels: {
            color: CHART_TEXT,
            boxWidth: 8,
            padding: 12,
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          callbacks: {
            label(item) {
              const count = item.parsed;
              const percent = total ? Math.round((count / total) * 100) : 0;
              return ` ${item.label}: ${count} (${percent}%)`;
            },
          },
        },
      },
    },
  }));
}

function drawAnalyticsCharts(foodFreq, categoryByFood) {
  destroyCharts();
  createFoodChart(foodFreq, categoryByFood);
  createCategoryChart(foodFreq, categoryByFood);
}

function exportResults() {
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dininglens-results.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Results exported', 'success');
}

function render() {
  closeMealPopout({ restoreFocus: false });
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
    ${renderMealCalendar(agg.entries)}
    ${renderCharts()}`;

  bindMealCalendar();
  document.getElementById('export-btn')?.addEventListener('click', exportResults);
  document.getElementById('foods-expand-btn')?.addEventListener('click', () => {
    foodsExpanded = !foodsExpanded;
    drawAnalyticsCharts(agg.foodFreq, agg.categoryByFood);
  });

  drawAnalyticsCharts(agg.foodFreq, agg.categoryByFood);
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const [loadedResults, taxonomy] = await Promise.all([
      apiFetch('/api/results'),
      apiFetch('/api/food-taxonomy').catch((err) => {
        showToast(`Food grouping unavailable: ${err.message}`, 'error');
        return { entries: {} };
      }),
    ]);
    results = loadedResults;
    foodTaxonomy = taxonomy || { entries: {} };
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
