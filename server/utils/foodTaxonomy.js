const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('../db/settingsStore');
const { completeText } = require('./aiWrapper');
const {
  CATEGORIES,
  SYSTEM_PROMPT,
  buildUserMessage,
} = require('../prompts/foodTaxonomyPrompt');

const TAXONOMY_FILE = path.join(__dirname, '..', '..', 'processed', 'food-taxonomy.json');
const CATEGORY_SET = new Set(CATEGORIES);

const CATEGORY_ALIASES = {
  vegetable: 'Vegetables',
  vegetables: 'Vegetables',
  fruit: 'Fruits',
  fruits: 'Fruits',
  grain: 'Grains',
  grains: 'Grains',
  protein: 'Protein',
  proteins: 'Protein',
  dairy: 'Dairy',
  drink: 'Drinks',
  drinks: 'Drinks',
  beverage: 'Drinks',
  beverages: 'Drinks',
  'oils & fats': 'Oils & fats',
  'oils and fats': 'Oils & fats',
  'oil & fats': 'Oils & fats',
  'oil and fats': 'Oils & fats',
  fats: 'Oils & fats',
  fat: 'Oils & fats',
  oils: 'Oils & fats',
  other: 'Other',
};

let queue = Promise.resolve();

function collectFoodNames(results) {
  const names = new Set();
  for (const result of Object.values(results || {})) {
    for (const item of result?.items || []) {
      const name = String(item?.name || '').trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function nameSetHash(names) {
  return crypto.createHash('sha256').update(names.join('\n')).digest('hex');
}

function readTaxonomy() {
  try {
    return JSON.parse(fs.readFileSync(TAXONOMY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeTaxonomy(doc) {
  fs.mkdirSync(path.dirname(TAXONOMY_FILE), { recursive: true });
  const tempPath = `${TAXONOMY_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(doc, null, 2));
  fs.renameSync(tempPath, TAXONOMY_FILE);
}

function publicTaxonomy(doc) {
  return {
    updatedAt: doc?.updatedAt || null,
    entries: doc?.entries || {},
  };
}

function normalizeCategory(value) {
  const raw = String(value || '').trim();
  if (CATEGORY_SET.has(raw)) return raw;
  return CATEGORY_ALIASES[raw.toLowerCase().replace(/\s+/g, ' ')] || 'Other';
}

function cleanCanonical(value, fallback) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return text || String(fallback || '').trim().toLowerCase();
}

function parseModelJson(text) {
  const cleaned = String(text || '')
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
      } catch {
        // Fall through with a snippet from the original parse error.
      }
    }
    const match = /position (\d+)/.exec(err.message);
    const pos = match ? Number(match[1]) : 0;
    const snippet = cleaned.slice(Math.max(0, pos - 90), pos + 90);
    throw new Error(`${err.message} near ${JSON.stringify(snippet)}`);
  }
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
    const canonical = cleanCanonical(item.canonical, name);
    if (!canonical) continue;
    entries[name] = {
      canonical,
      category: normalizeCategory(item.category),
    };
  }

  return entries;
}

function existingAssignments(names, taxonomy) {
  if (!taxonomy?.entries) return [];
  return names.flatMap((name) => {
    const entry = taxonomy.entries[name];
    if (!entry?.canonical || !entry?.category) return [];
    return [{ name, canonical: entry.canonical, category: entry.category }];
  });
}

function coversNames(names, taxonomy) {
  if (!taxonomy?.entries) return false;
  return names.every((name) => {
    const entry = taxonomy.entries[name];
    return entry?.canonical && entry?.category;
  });
}

function sameNameSet(names, taxonomy) {
  const cached = Object.keys(taxonomy?.entries || {}).sort((a, b) => a.localeCompare(b));
  return cached.length === names.length && cached.every((name, index) => name === names[index]);
}

async function requestEntries(names, existing) {
  const settings = getSettings();
  const response = await completeText(settings, {
    system: SYSTEM_PROMPT,
    user: buildUserMessage(names, existing),
    meta: { filename: `food taxonomy (${names.length} names)` },
    maxOutputTokens: 8192,
    thinkingBudget: 0,
  });
  return {
    entries: parseEntries(response.text, names),
    provider: response.provider,
    model: response.model,
  };
}

async function classifyNames(names, previous) {
  const first = await requestEntries(names, existingAssignments(names, previous));
  const entries = { ...first.entries };
  const missing = names.filter((name) => !entries[name]);

  if (missing.length > 0) {
    const known = names
      .filter((name) => entries[name])
      .map((name) => ({ name, ...entries[name] }));
    const retry = await requestEntries(missing, known);
    Object.assign(entries, retry.entries);
  }

  for (const name of names) {
    if (!entries[name]) {
      entries[name] = { canonical: cleanCanonical(name, name), category: 'Other' };
    }
  }

  return {
    sourceHash: nameSetHash(names),
    updatedAt: new Date().toISOString(),
    provider: first.provider,
    model: first.model,
    entries,
  };
}

async function ensureTaxonomy(results) {
  const names = collectFoodNames(results);
  const current = readTaxonomy();

  if (names.length === 0) {
    const empty = {
      sourceHash: nameSetHash(names),
      updatedAt: new Date().toISOString(),
      entries: {},
    };
    writeTaxonomy(empty);
    return publicTaxonomy(empty);
  }

  if (coversNames(names, current) && sameNameSet(names, current)) {
    return publicTaxonomy(current);
  }

  if (coversNames(names, current)) {
    const entries = {};
    for (const name of names) entries[name] = current.entries[name];
    const pruned = {
      ...current,
      sourceHash: nameSetHash(names),
      entries,
    };
    writeTaxonomy(pruned);
    return publicTaxonomy(pruned);
  }

  const doc = await classifyNames(names, current);
  writeTaxonomy(doc);
  const canonicals = new Set(Object.values(doc.entries).map((entry) => entry.canonical));
  console.log(`Food taxonomy updated: ${names.length} names → ${canonicals.size} foods (${doc.model})`);
  return publicTaxonomy(doc);
}

function syncFoodTaxonomy(results) {
  const run = queue.then(() => ensureTaxonomy(results));
  queue = run.catch((err) => {
    console.error('Food taxonomy update failed:', err.message);
  });
  return run;
}

module.exports = {
  syncFoodTaxonomy,
  collectFoodNames,
};
