function mergeZoneResults(zoneResults) {
  const items = [];
  const zones_applied = [];

  for (const { zoneName, result } of zoneResults) {
    zones_applied.push(zoneName);

    for (const item of result.items || []) {
      items.push({ ...item, zone: zoneName });
    }
  }

  const zone_results = zoneResults.map(({ zoneName, result }) => ({
    zone: zoneName,
    items: result.items || [],
  }));

  return {
    items,
    zones_applied,
    zone_results,
    analyzed_per_zone: true,
    schema_version: 2,
  };
}

module.exports = { mergeZoneResults };
