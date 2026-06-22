export function isLegacyResult(result) {
  return Boolean(result?.zones && !result?.items);
}

export function confidenceClass(level) {
  const normalized = (level || '').toLowerCase();
  if (normalized === 'high') return 'confidence-high';
  if (normalized === 'medium') return 'confidence-medium';
  return 'confidence-low';
}

export function renderMealSummary(result, { compact = false } = {}) {
  if (!result) return '<p>No analysis results yet.</p>';

  if (isLegacyResult(result)) {
    return renderLegacySummary(result);
  }

  if (!result.items) {
    return '<p>Unknown result format.</p>';
  }

  const totals = result.totals || {};
  const insights = result.health_insights || { concerns: [], positives: [], summary: '' };

  const hasZones = result.items?.some((item) => item.zone);
  const zoneHeader = hasZones ? '<th>Zone</th>' : '';

  const itemsTable = result.items.length
    ? `
      <table class="meal-items-table">
        <thead>
          <tr>
            <th>Item</th>
            ${zoneHeader}
            <th>Portion</th>
            <th>Cal</th>
            <th>Protein</th>
            <th>Carbs</th>
            <th>Fat</th>
          </tr>
        </thead>
        <tbody>
          ${result.items.map((item) => `
            <tr class="${item.flagged ? 'flagged-item' : ''}">
              <td>
                ${item.flagged ? '<span class="flag-icon" title="Ambiguous item">⚠</span> ' : ''}
                ${item.name}
              </td>
              ${hasZones ? `<td>${item.zone || '—'}</td>` : ''}
              <td>${item.portion_estimate || '—'}</td>
              <td>${Math.round(item.calories || 0)}</td>
              <td>${(item.protein_g || 0).toFixed(1)}g</td>
              <td>${(item.carbs_total_g || 0).toFixed(1)}g</td>
              <td>${(item.fat_total_g || 0).toFixed(1)}g</td>
            </tr>
            ${item.flagged && item.flag_reason && !compact ? `
              <tr class="flag-reason-row"><td colspan="${hasZones ? 7 : 6}">${item.flag_reason}</td></tr>
            ` : ''}
          `).join('')}
        </tbody>
      </table>`
    : '<p>No food items identified.</p>';

  if (compact) {
    const zoneSuffix = (item) => (item.zone ? ` · ${item.zone}` : '');
    return `
      <p><strong>${result.meal_name || 'Meal'}</strong></p>
      <span class="badge ${confidenceClass(result.confidence)}">${result.confidence || '—'} confidence</span>
      ${result.zones_applied?.length ? `<p style="margin-top: 0.35rem; font-size: 0.75rem; color: var(--color-text-muted);">Zones: ${result.zones_applied.join(', ')}</p>` : ''}
      <p style="margin-top: 0.5rem; font-size: 0.875rem;">
        ${Math.round(totals.calories || 0)} kcal ·
        ${(totals.protein_g || 0).toFixed(0)}g protein ·
        ${(totals.carbs_total_g || 0).toFixed(0)}g carbs ·
        ${(totals.fat_total_g || 0).toFixed(0)}g fat
      </p>
      <ul style="margin-top: 0.5rem; padding-left: 1.25rem; font-size: 0.875rem;">
        ${result.items.slice(0, 5).map((item) => `<li>${item.name}${zoneSuffix(item)} (${item.portion_estimate || '—'})</li>`).join('')}
        ${result.items.length > 5 ? `<li>+${result.items.length - 5} more</li>` : ''}
      </ul>`;
  }

  return `
    <div class="meal-result">
      <div class="meal-result-header">
        <h3>${result.meal_name || 'Meal Analysis'}</h3>
        <span class="badge ${confidenceClass(result.confidence)}">${result.confidence || '—'} confidence</span>
      </div>
      ${result.confidence_notes ? `<p class="confidence-notes">${result.confidence_notes}</p>` : ''}
      ${result.zones_applied?.length ? `<p class="confidence-notes">Analyzed per zone (${result.zones_applied.length} crops, ${result.zones_applied.join(', ')})</p>` : ''}

      <div class="meal-totals-grid">
        <div class="meal-total-card">
          <div class="meal-total-value">${Math.round(totals.calories || 0)}</div>
          <div class="meal-total-label">Calories</div>
        </div>
        <div class="meal-total-card">
          <div class="meal-total-value">${(totals.protein_g || 0).toFixed(0)}g</div>
          <div class="meal-total-label">Protein</div>
        </div>
        <div class="meal-total-card">
          <div class="meal-total-value">${(totals.carbs_total_g || 0).toFixed(0)}g</div>
          <div class="meal-total-label">Carbs</div>
        </div>
        <div class="meal-total-card">
          <div class="meal-total-value">${(totals.fat_total_g || 0).toFixed(0)}g</div>
          <div class="meal-total-label">Fat</div>
        </div>
      </div>

      <h4 class="meal-section-title">Items</h4>
      ${itemsTable}

      ${insights.summary || insights.concerns?.length || insights.positives?.length ? `
        <h4 class="meal-section-title">Health Insights</h4>
        ${insights.concerns?.length ? `
          <ul class="insight-list insight-concerns">
            ${insights.concerns.map((c) => `<li>${c}</li>`).join('')}
          </ul>
        ` : ''}
        ${insights.positives?.length ? `
          <ul class="insight-list insight-positives">
            ${insights.positives.map((p) => `<li>${p}</li>`).join('')}
          </ul>
        ` : ''}
        ${insights.summary ? `<p class="insight-summary">${insights.summary}</p>` : ''}
      ` : ''}
    </div>`;
}

const TOTAL_KEYS = [
  'calories',
  'protein_g',
  'fat_total_g',
  'fat_saturated_g',
  'carbs_total_g',
  'fiber_g',
  'sugars_g',
  'sodium_mg',
];

function sumItemTotals(items) {
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));
  for (const item of items || []) {
    for (const key of TOTAL_KEYS) {
      totals[key] += Number(item[key]) || 0;
    }
  }
  return totals;
}

function extractZoneSegment(text, zoneName, allZoneNames = []) {
  if (!text || !zoneName) return '';
  const marker = `${zoneName}:`;
  const start = text.indexOf(marker);
  if (start === -1) return '';

  const contentStart = start + marker.length;
  let end = text.length;

  for (const otherZone of allZoneNames) {
    if (otherZone === zoneName) continue;
    const otherMarker = `${otherZone}:`;
    const otherStart = text.indexOf(otherMarker, contentStart);
    if (otherStart !== -1 && otherStart < end) {
      end = otherStart;
    }
  }

  return text.slice(contentStart, end).trim();
}

function orderZoneNames(zoneNames, settingsZones = []) {
  const unique = [...new Set(zoneNames.filter(Boolean))];
  if (!settingsZones?.length) return unique;

  const order = settingsZones.map((zone) => zone.name);
  return unique.sort((a, b) => {
    const indexA = order.indexOf(a);
    const indexB = order.indexOf(b);
    if (indexA === -1 && indexB === -1) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });
}

export function getGalleryZoneTabs(result, settingsZones = []) {
  if (!result) return [];

  if (isLegacyResult(result)) {
    const zones = result.zones || [];
    if (zones.length <= 1) return [];
    return [
      { id: 'all', label: 'All zones', zoneName: null },
      ...zones.map((zone, index) => ({
        id: `zone-${index}`,
        label: zone.name,
        zoneName: zone.name,
      })),
    ];
  }

  const zoneNames = orderZoneNames(
    result.zones_applied?.length
      ? result.zones_applied
      : (result.items || []).map((item) => item.zone),
    settingsZones,
  );

  if (zoneNames.length <= 1) return [];

  return [
    { id: 'all', label: 'All zones', zoneName: null },
    ...zoneNames.map((zoneName, index) => ({
      id: `zone-${index}`,
      label: zoneName,
      zoneName,
    })),
  ];
}

function zoneCropUrl(filePath, zoneName) {
  if (!filePath || !zoneName) return '';
  return `/api/zone-crop?file=${encodeURIComponent(filePath)}&zone=${encodeURIComponent(zoneName)}`;
}

function getFilePath(file) {
  if (!file) return null;
  return file.path || file.name || null;
}

function canShowZoneCrops(file) {
  return file?.type === 'image' && Boolean(getFilePath(file));
}

function renderZoneCropPreview(filePath, zoneName, { caption } = {}) {
  if (!filePath || !zoneName) return '';

  const label = caption || zoneName;
  return `
    <figure class="analysis-zone-crop">
      <img
        src="${zoneCropUrl(filePath, zoneName)}"
        alt="Cropped zone: ${label}"
        loading="lazy"
      >
      <figcaption>${label}</figcaption>
    </figure>`;
}

function renderAllZoneCrops(filePath, zoneNames) {
  if (!filePath || !zoneNames.length) return '';

  return `
    <div class="analysis-zone-crops-grid">
      ${zoneNames.map((zoneName) => renderZoneCropPreview(filePath, zoneName)).join('')}
    </div>`;
}

function getZoneSnapshot(result, zoneName) {
  const stored = result.zone_results?.find((entry) => entry.zone === zoneName);
  if (stored) return stored;

  const zoneNames = result.zones_applied?.length
    ? result.zones_applied
    : [...new Set((result.items || []).map((item) => item.zone).filter(Boolean))];
  const items = (result.items || []).filter((item) => item.zone === zoneName);
  return {
    zone: zoneName,
    meal_name: items.length ? items.map((item) => item.name).slice(0, 2).join(', ') : zoneName,
    confidence: null,
    confidence_notes: extractZoneSegment(result.confidence_notes, zoneName, zoneNames),
    items,
    totals: sumItemTotals(items),
    health_insights: {
      concerns: result.health_insights?.concerns || [],
      positives: result.health_insights?.positives || [],
      summary: extractZoneSegment(result.health_insights?.summary, zoneName, zoneNames),
    },
  };
}

function scopeResultForTab(result, tab) {
  if (tab.id === 'all') return result;

  if (isLegacyResult(result)) {
    const zone = (result.zones || []).find((entry) => entry.name === tab.zoneName);
    if (!zone) return result;
    return {
      legacyZone: zone,
      zoneName: tab.zoneName,
    };
  }

  const snapshot = getZoneSnapshot(result, tab.zoneName);
  return {
    meal_name: snapshot.meal_name || tab.zoneName,
    confidence: snapshot.confidence || '—',
    confidence_notes: snapshot.confidence_notes,
    items: snapshot.items || [],
    totals: snapshot.totals || {},
    health_insights: snapshot.health_insights || { concerns: [], positives: [], summary: '' },
    zoneName: tab.zoneName,
  };
}

function renderAnalyticsStats(items, totals) {
  const flaggedCount = items.filter((item) => item.flagged).length;
  return `
    <div class="analysis-stats-row">
      <div class="analysis-stat">
        <span class="analysis-stat-value">${items.length}</span>
        <span class="analysis-stat-label">Items</span>
      </div>
      <div class="analysis-stat">
        <span class="analysis-stat-value">${Math.round(totals.calories || 0)}</span>
        <span class="analysis-stat-label">Calories</span>
      </div>
      <div class="analysis-stat">
        <span class="analysis-stat-value">${(totals.protein_g || 0).toFixed(0)}g</span>
        <span class="analysis-stat-label">Protein</span>
      </div>
      ${flaggedCount ? `
        <div class="analysis-stat analysis-stat-warning">
          <span class="analysis-stat-value">${flaggedCount}</span>
          <span class="analysis-stat-label">Flagged</span>
        </div>
      ` : ''}
    </div>`;
}

function renderExtendedTotalsGrid(totals) {
  const cards = [
    { label: 'Calories', value: Math.round(totals.calories || 0) },
    { label: 'Protein', value: `${(totals.protein_g || 0).toFixed(0)}g` },
    { label: 'Carbs', value: `${(totals.carbs_total_g || 0).toFixed(0)}g` },
    { label: 'Fat', value: `${(totals.fat_total_g || 0).toFixed(0)}g` },
    { label: 'Fiber', value: `${(totals.fiber_g || 0).toFixed(0)}g` },
    { label: 'Sugars', value: `${(totals.sugars_g || 0).toFixed(0)}g` },
    { label: 'Sodium', value: `${Math.round(totals.sodium_mg || 0)}mg` },
    { label: 'Sat. fat', value: `${(totals.fat_saturated_g || 0).toFixed(0)}g` },
  ];

  return `
    <div class="meal-totals-grid analysis-totals-grid">
      ${cards.map((card) => `
        <div class="meal-total-card">
          <div class="meal-total-value">${card.value}</div>
          <div class="meal-total-label">${card.label}</div>
        </div>
      `).join('')}
    </div>`;
}

function renderItemsTable(items, { showZone = false, compactHeaders = false } = {}) {
  if (!items.length) return '<p class="analysis-empty">No food items identified in this zone.</p>';

  const zoneHeader = showZone ? '<th>Zone</th>' : '';
  const colspan = showZone ? 7 : 6;
  const proteinLabel = compactHeaders ? 'P' : 'Protein';
  const carbsLabel = compactHeaders ? 'C' : 'Carbs';
  const fatLabel = compactHeaders ? 'F' : 'Fat';

  return `
    <div class="analysis-items-table-wrap">
      <table class="meal-items-table">
        <thead>
          <tr>
            <th>Item</th>
            ${zoneHeader}
            <th>Portion</th>
            <th>Cal</th>
            <th>${proteinLabel}</th>
            <th>${carbsLabel}</th>
            <th>${fatLabel}</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => `
            <tr class="${item.flagged ? 'flagged-item' : ''}">
              <td>
                ${item.flagged ? '<span class="flag-icon" title="Ambiguous item">⚠</span> ' : ''}
                ${item.name}
              </td>
              ${showZone ? `<td>${item.zone || '—'}</td>` : ''}
              <td>${item.portion_estimate || '—'}</td>
              <td>${Math.round(item.calories || 0)}</td>
              <td>${(item.protein_g || 0).toFixed(1)}</td>
              <td>${(item.carbs_total_g || 0).toFixed(1)}</td>
              <td>${(item.fat_total_g || 0).toFixed(1)}</td>
            </tr>
            ${item.flagged && item.flag_reason ? `
              <tr class="flag-reason-row"><td colspan="${colspan}">${item.flag_reason}</td></tr>
            ` : ''}
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderHealthInsights(insights) {
  if (!insights?.summary && !insights?.concerns?.length && !insights?.positives?.length) {
    return '';
  }

  return `
    <h4 class="meal-section-title">Health Insights</h4>
    ${insights.concerns?.length ? `
      <ul class="insight-list insight-concerns">
        ${insights.concerns.map((concern) => `<li>${concern}</li>`).join('')}
      </ul>
    ` : ''}
    ${insights.positives?.length ? `
      <ul class="insight-list insight-positives">
        ${insights.positives.map((positive) => `<li>${positive}</li>`).join('')}
      </ul>
    ` : ''}
    ${insights.summary ? `<p class="insight-summary">${insights.summary}</p>` : ''}`;
}

function renderLegacyZonePanel(zone, filePath) {
  const foods = zone.foods || [];
  return `
    <div class="meal-result gallery-analysis">
      ${filePath ? renderZoneCropPreview(filePath, zone.name) : ''}
      <div class="analysis-zone-heading">
        <h3 class="analysis-zone-title">${zone.name}</h3>
      </div>
      <div class="analysis-stats-row">
        <div class="analysis-stat">
          <span class="analysis-stat-value">${foods.length}</span>
          <span class="analysis-stat-label">Items</span>
        </div>
      </div>
      <h4 class="meal-section-title">Foods</h4>
      <ul class="analysis-legacy-list">
        ${foods.map((food) => `
          <li>
            <strong>${food.item}</strong>
            <span>${food.portion || '—'}</span>
            ${food.ingredients?.length ? `<em>${food.ingredients.join(', ')}</em>` : ''}
          </li>
        `).join('')}
      </ul>
    </div>`;
}

function renderLegacyAllPanel(result, filePath) {
  const zones = result.zones || [];
  return `
    <div class="meal-result gallery-analysis">
      <p class="confidence-notes"><em>Legacy zone-based result</em></p>
      ${filePath ? renderAllZoneCrops(filePath, zones.map((zone) => zone.name)) : ''}
      ${zones.map((zone) => renderLegacyZonePanel(zone, null)).join('')}
    </div>`;
}

function getZoneNamesForResult(result, settingsZones = []) {
  if (isLegacyResult(result)) {
    return (result.zones || []).map((zone) => zone.name);
  }
  return orderZoneNames(
    result.zones_applied?.length
      ? result.zones_applied
      : (result.items || []).map((item) => item.zone),
    settingsZones,
  );
}

function renderGalleryZoneContent(result, tab, { file, settingsZones = [] } = {}) {
  const scoped = scopeResultForTab(result, tab);
  const filePath = canShowZoneCrops(file) ? getFilePath(file) : null;

  if (scoped.legacyZone) {
    return renderLegacyZonePanel(scoped.legacyZone, filePath);
  }

  if (tab.id === 'all' && isLegacyResult(result)) {
    return renderLegacyAllPanel(result, filePath);
  }

  const items = scoped.items || [];
  const totals = scoped.totals || {};
  const insights = scoped.health_insights || { concerns: [], positives: [], summary: '' };
  const showZoneColumn = tab.id === 'all' && items.some((item) => item.zone);
  const zoneNames = getZoneNamesForResult(result, settingsZones);

  return `
    <div class="meal-result gallery-analysis">
      ${tab.id === 'all' && filePath && zoneNames.length
    ? `
        <h4 class="meal-section-title">Zone Crops</h4>
        <p class="confidence-notes">Each crop below was sent to the AI for analysis.</p>
        ${renderAllZoneCrops(filePath, zoneNames)}
      `
    : ''}
      ${scoped.zoneName ? `
        ${filePath ? renderZoneCropPreview(filePath, scoped.zoneName) : ''}
        <div class="analysis-zone-heading">
          <h3 class="analysis-zone-title">${scoped.zoneName}</h3>
          ${scoped.meal_name && scoped.meal_name !== scoped.zoneName
    ? `<p class="analysis-zone-subtitle">${scoped.meal_name}</p>`
    : ''}
        </div>
      ` : `
        <div class="meal-result-header">
          <h3>${scoped.meal_name || 'Meal Analysis'}</h3>
          <span class="badge ${confidenceClass(scoped.confidence)}">${scoped.confidence || '—'} confidence</span>
        </div>
      `}

      ${scoped.zoneName && scoped.confidence ? `
        <div class="analysis-zone-meta">
          <span class="badge ${confidenceClass(scoped.confidence)}">${scoped.confidence} confidence</span>
        </div>
      ` : ''}

      ${scoped.confidence_notes ? `<p class="confidence-notes">${scoped.confidence_notes}</p>` : ''}
      ${tab.id === 'all' && result.zones_applied?.length ? `
        <p class="confidence-notes">Analyzed across ${result.zones_applied.length} zones: ${result.zones_applied.join(', ')}</p>
      ` : ''}

      ${renderAnalyticsStats(items, totals)}
      <h4 class="meal-section-title">Nutrition</h4>
      ${renderExtendedTotalsGrid(totals)}
      <h4 class="meal-section-title">Items (${items.length})</h4>
      ${renderItemsTable(items, { showZone: showZoneColumn })}
      ${renderHealthInsights(insights)}
    </div>`;
}

export function renderGalleryAnalysisPanel(result, settingsZones = [], activeTabId = 'all', file = null) {
  if (!result) return '<p>No analysis results yet.</p>';

  const tabs = getGalleryZoneTabs(result, settingsZones);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || { id: 'all', label: 'All zones', zoneName: null };
  const content = renderGalleryZoneContent(result, activeTab, { file, settingsZones });

  if (!tabs.length) {
    return `<div class="gallery-analysis-wrap">${content}</div>`;
  }

  return `
    <div class="gallery-analysis-wrap">
      <div class="analysis-zone-tabs" role="tablist" aria-label="Zone analysis">
        ${tabs.map((tab) => `
          <button
            type="button"
            role="tab"
            class="analysis-zone-tab${tab.id === activeTab.id ? ' active' : ''}"
            data-zone-tab="${tab.id}"
            aria-selected="${tab.id === activeTab.id}"
            title="${tab.label}"
          >${tab.label}</button>
        `).join('')}
      </div>
      <div class="analysis-zone-content" role="tabpanel">
        ${content}
      </div>
    </div>`;
}

export function getActiveZoneName(result, settingsZones, activeTabId) {
  const tabs = getGalleryZoneTabs(result, settingsZones);
  const tab = tabs.find((entry) => entry.id === activeTabId);
  return tab?.zoneName || null;
}

function renderLegacySummary(result) {
  const tabs = getGalleryZoneTabs(result);
  if (tabs.length) {
    return renderGalleryZoneContent(result, tabs[0]);
  }

  let html = '<p><em>Legacy zone-based result</em></p>';
  html += (result.zones || []).map((zone) => `
    <div style="margin-top: 0.75rem;">
      <strong>${zone.name}</strong>
      <ul style="margin-top: 0.25rem; padding-left: 1.25rem; font-size: 0.875rem;">
        ${(zone.foods || []).map((f) => `
          <li>${f.item} (${f.portion}) — ${(f.ingredients || []).join(', ')}</li>
        `).join('')}
      </ul>
    </div>
  `).join('');
  return html;
}

export function normalizeResultForAnalytics(result) {
  if (isLegacyResult(result)) {
    const items = [];
    for (const zone of result.zones || []) {
      for (const food of zone.foods || []) {
        items.push({ name: food.item, zone: zone.name });
      }
    }
    return { type: 'legacy', items, totals: null, confidence: null };
  }

  return {
    type: 'meal',
    items: result.items || [],
    totals: result.totals || {},
    confidence: result.confidence || null,
  };
}

export const PROCESSING_ERROR_MSG =
  "We couldn't analyze this photo. Try a clearer image with better lighting.";
