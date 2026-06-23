export function isLegacyResult(result) {
  return Boolean(result?.zones && !result?.items);
}

export function isMacroResult(result) {
  if (!result?.items?.length) return false;
  return Boolean(
    result.totals
    || result.meal_name
    || result.confidence
    || result.items[0]?.calories != null
    || result.items[0]?.portion_estimate,
  );
}

export function isFoodRecognitionResult(result) {
  return Boolean(result?.items?.length && !isLegacyResult(result) && !isMacroResult(result));
}

export function sumItemWeights(items) {
  return (items || []).reduce((sum, item) => sum + (Number(item.estimated_weight_grams) || 0), 0);
}

export function formatWeight(grams) {
  const value = Number(grams) || 0;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} kg`;
  return `${Math.round(value)} g`;
}

function formatCount(item) {
  if (item.count == null || item.count === '') return '—';
  return String(item.count);
}

function compositeLabel(item) {
  return item.is_composite
    ? '<span class="badge badge-muted">Composite</span>'
    : '<span class="badge badge-success">Single</span>';
}

export function renderMealSummary(result, { compact = false } = {}) {
  if (!result) return '<p>No analysis results yet.</p>';

  if (isLegacyResult(result)) {
    return renderLegacySummary(result);
  }

  if (isMacroResult(result)) {
    return `
      <div class="meal-result">
        <p class="confidence-notes"><em>Older macro-based result.</em> Re-process this photo to use the simplified food recognition format.</p>
        ${renderItemsTable(result.items || [], { legacyMacro: true })}
      </div>`;
  }

  if (!result.items) {
    return '<p>Unknown result format.</p>';
  }

  const items = result.items || [];
  const totalWeight = sumItemWeights(items);

  if (compact) {
    const zoneSuffix = (item) => (item.zone ? ` · ${item.zone}` : '');
    return `
      <p><strong>${items.length} item${items.length === 1 ? '' : 's'}</strong> · ${formatWeight(totalWeight)} total</p>
      ${result.zones_applied?.length ? `<p style="margin-top: 0.35rem; font-size: 0.75rem; color: var(--color-text-muted);">Zones: ${result.zones_applied.join(', ')}</p>` : ''}
      <ul style="margin-top: 0.5rem; padding-left: 1.25rem; font-size: 0.875rem;">
        ${items.slice(0, 5).map((item) => `<li>${item.name}${zoneSuffix(item)} (${formatWeight(item.estimated_weight_grams)})</li>`).join('')}
        ${items.length > 5 ? `<li>+${items.length - 5} more</li>` : ''}
      </ul>`;
  }

  return `
    <div class="meal-result">
      ${result.zones_applied?.length ? `<p class="confidence-notes">Analyzed per zone (${result.zones_applied.length} crops, ${result.zones_applied.join(', ')})</p>` : ''}
      ${renderAnalyticsStats(items)}
      <h4 class="meal-section-title">Identified Foods (${items.length})</h4>
      ${renderItemsTable(items, { showZone: items.some((item) => item.zone) })}
    </div>`;
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
  const cacheBust = Date.now();
  return `/api/zone-crop?file=${encodeURIComponent(filePath)}&zone=${encodeURIComponent(zoneName)}&t=${cacheBust}`;
}

function getFilePath(file) {
  if (!file) return null;
  return file.path || file.name || null;
}

function canShowZoneCrops(file) {
  return file?.type === 'image' && Boolean(getFilePath(file));
}

function renderZoneCropPreview(filePath, zoneName) {
  if (!filePath || !zoneName) return '';

  return `
    <figure class="analysis-zone-crop">
      <img
        src="${zoneCropUrl(filePath, zoneName)}"
        alt="Cropped zone: ${zoneName}"
        loading="lazy"
      >
      <figcaption>${zoneName}</figcaption>
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

  return {
    zone: zoneName,
    items: (result.items || []).filter((item) => item.zone === zoneName),
  };
}

function scopeResultForTab(result, tab) {
  if (tab.id === 'all') return result;

  if (isLegacyResult(result)) {
    const zone = (result.zones || []).find((entry) => entry.name === tab.zoneName);
    if (!zone) return result;
    return { legacyZone: zone, zoneName: tab.zoneName };
  }

  const snapshot = getZoneSnapshot(result, tab.zoneName);
  return {
    items: snapshot.items || [],
    zoneName: tab.zoneName,
  };
}

function renderAnalyticsStats(items) {
  const compositeCount = items.filter((item) => item.is_composite).length;
  const totalWeight = sumItemWeights(items);

  return `
    <div class="analysis-stats-row">
      <div class="analysis-stat">
        <span class="analysis-stat-value">${items.length}</span>
        <span class="analysis-stat-label">Items</span>
      </div>
      <div class="analysis-stat">
        <span class="analysis-stat-value">${formatWeight(totalWeight)}</span>
        <span class="analysis-stat-label">Total weight</span>
      </div>
      ${compositeCount ? `
        <div class="analysis-stat">
          <span class="analysis-stat-value">${compositeCount}</span>
          <span class="analysis-stat-label">Composite</span>
        </div>
      ` : ''}
    </div>`;
}

function renderItemsTable(items, { showZone = false, legacyMacro = false } = {}) {
  if (!items.length) return '<p class="analysis-empty">No food items identified.</p>';

  if (legacyMacro) {
    return `
      <div class="analysis-items-table-wrap">
        <table class="meal-items-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Portion</th>
              <th>Cal</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((item) => `
              <tr>
                <td>${item.name}</td>
                <td>${item.portion_estimate || '—'}</td>
                <td>${Math.round(item.calories || 0)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
  }

  const zoneHeader = showZone ? '<th>Zone</th>' : '';

  return `
    <div class="analysis-items-table-wrap">
      <table class="meal-items-table">
        <thead>
          <tr>
            <th>Food</th>
            ${zoneHeader}
            <th>Weight</th>
            <th>Count</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => `
            <tr>
              <td>${item.name}</td>
              ${showZone ? `<td>${item.zone || '—'}</td>` : ''}
              <td>${formatWeight(item.estimated_weight_grams)}</td>
              <td>${formatCount(item)}</td>
              <td>${compositeLabel(item)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
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

  if (isMacroResult(scoped)) {
    return `
      <div class="meal-result gallery-analysis">
        <p class="confidence-notes"><em>Older macro-based result.</em> Re-process to use food recognition with estimated weights.</p>
        ${renderItemsTable(scoped.items || [], { legacyMacro: true })}
      </div>`;
  }

  const items = scoped.items || [];
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
        </div>
      ` : `
        <div class="meal-result-header">
          <h3>Food Recognition</h3>
        </div>
      `}
      ${tab.id === 'all' && result.zones_applied?.length ? `
        <p class="confidence-notes">Analyzed across ${result.zones_applied.length} zones: ${result.zones_applied.join(', ')}</p>
      ` : ''}
      ${renderAnalyticsStats(items)}
      <h4 class="meal-section-title">Identified Foods (${items.length})</h4>
      ${renderItemsTable(items, { showZone: showZoneColumn })}
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
    return { type: 'legacy', items, totalWeight: 0 };
  }

  if (isMacroResult(result)) {
    return { type: 'macro', items: result.items || [], totalWeight: 0 };
  }

  const items = result.items || [];
  return {
    type: 'food',
    items,
    totalWeight: sumItemWeights(items),
  };
}

export const PROCESSING_ERROR_MSG =
  "We couldn't analyze this photo. Try a clearer image with better lighting.";
