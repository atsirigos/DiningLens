const CONFIDENCE_RANK = { High: 3, Medium: 2, Low: 1 };

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

function mergeZoneResults(zoneResults) {
  const items = [];
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));
  const concerns = [];
  const positives = [];
  const summaries = [];
  const notes = [];
  const zones_applied = [];
  let confidence = 'High';

  for (const { zoneName, result } of zoneResults) {
    zones_applied.push(zoneName);

    for (const item of result.items || []) {
      items.push({ ...item, zone: zoneName });
    }

    for (const key of TOTAL_KEYS) {
      totals[key] += Number(result.totals?.[key]) || 0;
    }

    if (result.confidence_notes) {
      notes.push(`${zoneName}: ${result.confidence_notes}`);
    }

    for (const c of result.health_insights?.concerns || []) {
      if (!concerns.includes(c)) concerns.push(c);
    }
    for (const p of result.health_insights?.positives || []) {
      if (!positives.includes(p)) positives.push(p);
    }
    if (result.health_insights?.summary) {
      summaries.push(`${zoneName}: ${result.health_insights.summary}`);
    }

    const rank = CONFIDENCE_RANK[result.confidence] || 1;
    if (rank < (CONFIDENCE_RANK[confidence] || 3)) {
      confidence = result.confidence;
    }
  }

  const mealNames = zoneResults.map((zr) => zr.result.meal_name).filter(Boolean);
  const meal_name = zoneResults.length === 1 && mealNames[0]
    ? mealNames[0]
    : `Meal (${zoneResults.length} zones)`;

  return {
    meal_name,
    confidence,
    confidence_notes: notes.join(' '),
    items,
    totals,
    health_insights: {
      concerns,
      positives,
      summary: summaries.join(' '),
    },
    zones_applied,
    analyzed_per_zone: true,
  };
}

module.exports = { mergeZoneResults };
