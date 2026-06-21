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

  const itemsTable = result.items.length
    ? `
      <table class="meal-items-table">
        <thead>
          <tr>
            <th>Item</th>
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
              <td>${item.portion_estimate || '—'}</td>
              <td>${Math.round(item.calories || 0)}</td>
              <td>${(item.protein_g || 0).toFixed(1)}g</td>
              <td>${(item.carbs_total_g || 0).toFixed(1)}g</td>
              <td>${(item.fat_total_g || 0).toFixed(1)}g</td>
            </tr>
            ${item.flagged && item.flag_reason && !compact ? `
              <tr class="flag-reason-row"><td colspan="6">${item.flag_reason}</td></tr>
            ` : ''}
          `).join('')}
        </tbody>
      </table>`
    : '<p>No food items identified.</p>';

  if (compact) {
    return `
      <p><strong>${result.meal_name || 'Meal'}</strong></p>
      <span class="badge ${confidenceClass(result.confidence)}">${result.confidence || '—'} confidence</span>
      <p style="margin-top: 0.5rem; font-size: 0.875rem;">
        ${Math.round(totals.calories || 0)} kcal ·
        ${(totals.protein_g || 0).toFixed(0)}g protein ·
        ${(totals.carbs_total_g || 0).toFixed(0)}g carbs ·
        ${(totals.fat_total_g || 0).toFixed(0)}g fat
      </p>
      <ul style="margin-top: 0.5rem; padding-left: 1.25rem; font-size: 0.875rem;">
        ${result.items.slice(0, 5).map((item) => `<li>${item.name} (${item.portion_estimate || '—'})</li>`).join('')}
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

function renderLegacySummary(result) {
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
