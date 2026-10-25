const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('../db/settingsStore');
const { completeText } = require('./aiWrapper');
const { syncFoodTaxonomy } = require('./foodTaxonomy');
const { SYSTEM_PROMPT, buildUserMessage } = require('../prompts/foodNutritionPrompt');

const NUTRITION_FILE = path.join(__dirname, '..', '..', 'processed', 'food-nutrition.json');

let queue = Promise.resolve();

function nameSetHash(names) {
  return crypto.createHash('sha256').update(names.join('\n')).digest('hex');
}

function readNutrition() {
  try {
    const doc = JSON.parse(fs.readFileSync(NUTRITION_FILE, 'utf8'));
    return {
      entries: doc?.entries && typeof doc.entries === 'object' ? doc.entries : {},
      skipped: Array.isArray(doc?.skipped) ? doc.skipped : [],
      updatedAt: doc?.updatedAt || null,
      provider: doc?.provider,
      model: doc?.model,
    };
  } catch {
    return null;
  }
}

function writeNutrition(doc) {
  fs.mkdirSync(path.dirname(NUTRITION_FILE), { recursive: true });
  const tempPath = `${NUTRITION_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(doc, null, 2));
  fs.renameSync(tempPath, NUTRITION_FILE);
}

function publicNutrition(doc) {
  return {
    updatedAt: doc?.updatedAt || null,
    entries: doc?.entries || {},
  };
}

function numberFrom(item, keys) {
  for (const key of keys) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function nutritionEntry(item) {
  const kcalPer100g = numberFrom(item, ['kcalPer100g', 'kcal', 'calories', 'caloriesPer100g']);
  const proteinPer100g = numberFrom(item, ['proteinPer100g', 'protein_g', 'protein']);
  const carbPer100g = numberFrom(item, ['carbPer100g', 'carbohydratePer100g', 'carbsPer100g', 'carb', 'carbs']);
  const fatPer100g = numberFrom(item, ['fatPer100g', 'fat_g', 'fat']);
  if ([kcalPer100g, proteinPer100g, carbPer100g, fatPer100g].some((value) => value == null)) {
    return null;
  }
  return {
    kcalPer100g: Math.round(kcalPer100g * 10) / 10,
    proteinPer100g: Math.round(proteinPer100g * 10) / 10,
    carbPer100g: Math.round(carbPer100g * 10) / 10,
    fatPer100g: Math.round(fatPer100g * 10) / 10,
  };
}

function plausibleNutrition(entry) {
  if (!entry) return false;
  const values = [entry.kcalPer100g, entry.proteinPer100g, entry.carbPer100g, entry.fatPer100g];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return false;
  if (entry.kcalPer100g > 900) return false;
  if (entry.proteinPer100g + entry.carbPer100g + entry.fatPer100g > 100) return false;
  return true;
}

function parseModelJson(text) {
  const cleaned = String(text || '')
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
    .replace(/,\s*([}\]])/g, '$1');
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('Food nutrition response was not JSON');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(cleaned.slice(start, index + 1));
    }
  }
  throw new Error('Food nutrition response was not JSON');
}

function parseEntries(text, allowedNames) {
  const byLower = new Map(allowedNames.map((name) => [name.toLowerCase(), name]));
  const parsed = parseModelJson(text);
  const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.foods || []);
  const entries = {};

  for (const item of items) {
    const rawName = String(item?.name || '').trim();
    const name = byLower.get(rawName.toLowerCase());
    if (!name || entries[name]) continue;
    const entry = nutritionEntry(item);
    if (!plausibleNutrition(entry)) continue;
    entries[name] = entry;
  }

  return entries;
}

function canonicalNames(results, taxonomy) {
  const names = new Set();
  for (const result of Object.values(results || {})) {
    for (const item of result?.items || []) {
      const raw = String(item?.name || '').trim();
      if (!raw) continue;
      names.add(taxonomy?.entries?.[raw]?.canonical || raw);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function isResolved(name, doc) {
  return plausibleNutrition(doc?.entries?.[name]) || (doc?.skipped || []).includes(name);
}

function coversNames(names, doc) {
  return Boolean(doc) && names.every((name) => isResolved(name, doc));
}

function sameNameSet(names, doc) {
  const known = [
    ...Object.keys(doc?.entries || {}),
    ...(doc?.skipped || []),
  ].sort((a, b) => a.localeCompare(b));
  return known.length === names.length && known.every((name, index) => name === names[index]);
}

function prunedDoc(names, doc) {
  const nameSet = new Set(names);
  const entries = {};
  for (const [name, entry] of Object.entries(doc?.entries || {})) {
    if (nameSet.has(name) && plausibleNutrition(entry)) entries[name] = entry;
  }
  const skipped = (doc?.skipped || []).filter((name) => nameSet.has(name) && !entries[name]);
  return {
    sourceHash: nameSetHash(names),
    updatedAt: doc?.updatedAt || new Date().toISOString(),
    provider: doc?.provider,
    model: doc?.model,
    entries,
    skipped,
  };
}

async function requestEntries(names) {
  const settings = getSettings();
  const response = await completeText(settings, {
    system: SYSTEM_PROMPT,
    user: buildUserMessage(names),
    meta: { filename: `food nutrition (${names.length} foods)` },
    maxOutputTokens: 8192,
    thinkingBudget: 0,
  });
  return parseEntries(response.text, names);
}

async function estimateNames(names, previous) {
  const kept = prunedDoc(names, previous || { entries: {}, skipped: [] });
  const missing = names.filter((name) => !isResolved(name, kept));
  if (missing.length === 0) return kept;

  const found = await requestEntries(missing);
  const entries = { ...kept.entries, ...found };
  let stillMissing = missing.filter((name) => !entries[name]);
  if (stillMissing.length > 0) {
    Object.assign(entries, await requestEntries(stillMissing));
    stillMissing = missing.filter((name) => !entries[name]);
  }

  const skipped = [...kept.skipped, ...stillMissing];
  const doc = {
    sourceHash: nameSetHash(names),
    updatedAt: new Date().toISOString(),
    entries,
    skipped,
  };
  console.log(`Food nutrition updated: ${Object.keys(entries).length} foods, ${skipped.length} skipped`);
  return doc;
}

async function ensureNutrition(results, taxonomy) {
  const names = canonicalNames(results, taxonomy);
  const current = readNutrition();

  if (names.length === 0) {
    const empty = {
      sourceHash: nameSetHash(names),
      updatedAt: new Date().toISOString(),
      entries: {},
      skipped: [],
    };
    writeNutrition(empty);
    return publicNutrition(empty);
  }

  if (coversNames(names, current) && sameNameSet(names, current)) {
    return publicNutrition(current);
  }

  if (coversNames(names, current)) {
    const pruned = prunedDoc(names, current);
    writeNutrition(pruned);
    return publicNutrition(pruned);
  }

  const doc = await estimateNames(names, current);
  writeNutrition(doc);
  return publicNutrition(doc);
}

function syncFoodNutrition(results, taxonomy) {
  const run = queue.then(async () => {
    const resolved = taxonomy || await syncFoodTaxonomy(results);
    return ensureNutrition(results, resolved);
  });
  queue = run.catch((err) => {
    console.error('Food nutrition update failed:', err.message);
  });
  return run;
}

module.exports = {
  syncFoodNutrition,
  plausibleNutrition,
};
