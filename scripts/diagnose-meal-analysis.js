#!/usr/bin/env node
/**
 * DiningLens meal analysis diagnostic tool.
 * Runs preflight checks and live API analysis on images in data/.
 *
 * Usage:
 *   npm run diagnose
 *   npm run diagnose -- --file 20260425_134151.jpg
 *   npm run diagnose -- --dry-run
 *   npm run diagnose -- --context "half portion"
 *   npm run diagnose -- --verbose
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const { DB_PATH } = require('../server/db/database');

const { scanDataFolder } = require('../server/utils/fileScanner');
const { getSettings } = require('../server/db/settingsStore');
const {
  AI_PROVIDERS,
  ENV_KEYS,
  resolveApiKey,
  resolveModel,
  getProviderModels,
} = require('../server/utils/aiConfig');
const { analyzeImage } = require('../server/utils/aiWrapper');
const { buildUserMessage } = require('../server/prompts/mealAnalysisPrompt');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const log = {
  ok: (msg) => console.log(`  [OK]   ${msg}`),
  fail: (msg) => console.log(`  [FAIL] ${msg}`),
  warn: (msg) => console.log(`  [WARN] ${msg}`),
  info: (msg) => console.log(`  [INFO] ${msg}`),
  step: (msg) => console.log(`\n== ${msg} ==`),
};

function parseArgs(argv) {
  const args = {
    file: null,
    dryRun: false,
    context: null,
    verbose: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--context') args.context = argv[++i];
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
    else if (arg.startsWith('--context=')) args.context = arg.slice('--context='.length);
    else log.warn(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`
DiningLens meal analysis diagnostic

Options:
  --file <name>      Analyze a single image from data/ (default: all images)
  --context <text>   Optional meal context passed to the AI prompt
  --dry-run          Run preflight checks only; skip live API calls
  --verbose          Print raw API response text when parsing/validation fails
  -h, --help         Show this help

Examples:
  npm run diagnose
  npm run diagnose -- --file 20260425_134151.jpg --verbose
  npm run diagnose -- --dry-run
`);
}

function maskKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return `${'*'.repeat(key.length - 4)}${key.slice(-4)}`;
}

function classifyApiError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  const status = err?.status || err?.statusCode || err?.response?.status;

  if (status === 401 || status === 403 || msg.includes('api key') || msg.includes('authentication') || msg.includes('permission')) {
    return {
      category: 'AUTH',
      hint: 'Invalid or missing API key. Set it in Settings (saved to SQLite) or in .env.',
    };
  }
  if (status === 404 || msg.includes('not found') || msg.includes('model')) {
    return {
      category: 'MODEL',
      hint: 'Model ID may be invalid or unavailable for vision. Try a different model in Settings.',
    };
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('quota') || msg.includes('resource exhausted')) {
    return {
      category: 'RATE_LIMIT',
      hint: 'Provider rate limit or quota exceeded. Wait and retry, or switch models.',
    };
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused') || msg.includes('timeout')) {
    return {
      category: 'NETWORK',
      hint: 'Network error reaching the provider API. Check internet connectivity.',
    };
  }
  if (msg.includes('json') || msg.includes('unexpected token') || msg.includes('parse')) {
    return {
      category: 'PARSE',
      hint: 'Response was not valid JSON. Try again or switch models; use --verbose to inspect raw text.',
    };
  }
  if (msg.includes('missing required fields') || msg.includes('invalid meal analysis')) {
    return {
      category: 'VALIDATION',
      hint: 'API returned JSON but not the expected meal analysis schema.',
    };
  }
  if (msg.includes('unsupported image')) {
    return {
      category: 'IMAGE',
      hint: 'Image type not supported. Use JPEG, PNG, or WebP.',
    };
  }
  if (msg.includes('not configured')) {
    return {
      category: 'CONFIG',
      hint: 'No API key found in Settings or .env for the selected provider.',
    };
  }

  return {
    category: 'UNKNOWN',
    hint: 'See error message above. Use --verbose for more detail.',
  };
}

function validateMealResultDetailed(result) {
  const issues = [];
  const warnings = [];

  if (!result || typeof result !== 'object') {
    issues.push('Result is not an object');
    return { issues, warnings };
  }

  if (!Array.isArray(result.items)) {
    issues.push('items must be an array');
    return { issues, warnings };
  }

  if (result.items.length === 0) {
    warnings.push('items array is empty — no foods identified');
  } else {
    result.items.forEach((item, i) => {
      const prefix = `items[${i}]`;
      if (!item.name) issues.push(`${prefix}: missing name`);
      if (typeof item.estimated_weight_grams !== 'number' || item.estimated_weight_grams <= 0) {
        issues.push(`${prefix}: estimated_weight_grams must be a number > 0`);
      }
      if (item.is_composite != null && typeof item.is_composite !== 'boolean') {
        warnings.push(`${prefix}: is_composite should be boolean`);
      }
      if (item.count != null && (typeof item.count !== 'number' || item.count <= 0)) {
        warnings.push(`${prefix}: count should be a positive number when provided`);
      }
    });
  }

  if (result.meal_name || result.totals || result.confidence) {
    warnings.push('Response looks like the old macro-based schema — update the prompt if this persists');
  }

  return { issues, warnings };
}

function checkEnvironment(settings) {
  const results = { passed: 0, failed: 0, warnings: 0 };

  log.step('1. Environment & configuration');

  if (fs.existsSync(path.join(ROOT, '.env'))) {
    log.ok('.env file found');
    results.passed++;
  } else {
    log.warn('.env not found — relying on Settings UI key or env vars already exported');
    results.warnings++;
  }

  if (fs.existsSync(DB_PATH)) {
    log.ok(`SQLite database: ${DB_PATH}`);
    results.passed++;
  } else {
    log.fail(`SQLite database missing: ${DB_PATH}`);
    results.failed++;
  }

  let settingsOk = false;
  try {
    const s = settings || getSettings();
    settingsOk = true;
    log.ok('Settings loaded from database');
    log.info(`Provider: ${s.ai?.provider || 'google'}`);
    log.info(`Model: ${resolveModel(s)}`);

    const provider = s.ai?.provider || 'google';
    const envVar = ENV_KEYS[provider];
    const fromSettings = s.ai?.apiKey?.trim() && s.ai.apiKey !== 'your_key_here';
    const fromEnv = process.env[envVar]?.trim() && process.env[envVar] !== 'your_key_here';
    const key = resolveApiKey(s);

    if (key) {
      log.ok(`API key resolved (${fromSettings ? 'Settings' : `.env ${envVar}`}): ${maskKey(key)}`);
      results.passed++;
    } else {
      log.fail(`No API key for provider "${provider}". Set in Settings or ${envVar} in .env`);
      results.failed++;
    }

    const models = getProviderModels(provider);
    const modelId = resolveModel(s);
    if (models.some((m) => m.id === modelId)) {
      log.ok(`Model "${modelId}" is valid for ${AI_PROVIDERS[provider]?.label || provider}`);
      results.passed++;
    } else {
      log.fail(`Model "${modelId}" is not in the provider model list`);
      results.failed++;
    }
  } catch (err) {
    log.fail(`Settings load failed: ${err.message}`);
    results.failed++;
  }

  if (fs.existsSync(DATA_DIR)) {
    log.ok(`data/ folder exists: ${DATA_DIR}`);
    results.passed++;
  } else {
    log.fail(`data/ folder missing: ${DATA_DIR}`);
    results.failed++;
  }

  return { results, settingsOk };
}

function checkImages(files) {
  log.step('2. Image inventory');

  const images = files.filter((f) => f.type === 'image');
  if (images.length === 0) {
    log.fail('No images found in data/');
    return { images: [], issues: 1 };
  }

  log.ok(`${images.length} image(s) found`);
  let issues = 0;

  for (const file of images) {
    const fullPath = path.join(DATA_DIR, file.path || file.name);
    const ext = path.extname(file.name).toLowerCase();

    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
      log.warn(`${file.name}: extension ${ext} may not be supported for analysis`);
    }

    if (!fs.existsSync(fullPath)) {
      log.fail(`${file.name}: file path does not exist (${fullPath})`);
      issues++;
      continue;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      log.fail(`${file.name}: ${(file.size / 1024 / 1024).toFixed(1)} MB exceeds 20 MB limit`);
      issues++;
    } else {
      log.ok(`${file.name}: ${(file.size / 1024).toFixed(0)} KB, modified ${file.modified}`);
    }
  }

  return { images, issues };
}

async function analyzeOneImage(file, settings, context, verbose) {
  const fullPath = path.join(DATA_DIR, file.path || file.name);
  const label = file.name;

  log.step(`3. Live API analysis: ${label}`);

  log.info(`User message: ${buildUserMessage(context).slice(0, 120)}${context ? '...' : ''}`);

  const start = Date.now();
  try {
    const result = await analyzeImage(fullPath, settings, context);
    const elapsed = Date.now() - start;

    log.ok(`API call succeeded in ${elapsed}ms`);
    log.info(`Items: ${result.items?.length ?? 0}`);
    const totalWeight = (result.items || []).reduce(
      (sum, item) => sum + (Number(item.estimated_weight_grams) || 0),
      0,
    );
    log.info(`Total visible weight: ${Math.round(totalWeight)} g`);

    const { issues, warnings } = validateMealResultDetailed(result);
    for (const w of warnings) log.warn(w);
    for (const issue of issues) log.fail(issue);

    if (issues.length === 0) {
      log.ok('Response schema validation passed');
      return { success: true, result, elapsed, issues, warnings };
    }

    return { success: false, result, elapsed, issues, warnings, error: 'Schema validation failed' };
  } catch (err) {
    const elapsed = Date.now() - start;
    const { category, hint } = classifyApiError(err);

    log.fail(`API call failed after ${elapsed}ms [${category}]`);
    log.fail(err.message);
    log.info(`Hint: ${hint}`);

    if (verbose && err.rawText) {
      console.log('\n--- Raw response ---\n', err.rawText.slice(0, 2000));
    }

    return { success: false, elapsed, error: err.message, category, hint };
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('\nDiningLens Meal Analysis Diagnostic\n');

  const settings = getSettings();
  const { results: envResults, settingsOk } = checkEnvironment(settings);

  const allFiles = scanDataFolder(DATA_DIR);
  let { images, issues: imageIssues } = checkImages(allFiles);

  if (args.file) {
    images = images.filter((f) => f.name === args.file || f.path === args.file);
    if (images.length === 0) {
      log.fail(`No image matching --file ${args.file}`);
      process.exit(1);
    }
  }

  if (args.dryRun) {
    log.step('Dry run — skipping live API calls');
    const failed = envResults.failed + imageIssues;
    console.log(`\nPreflight complete: ${envResults.passed} passed, ${failed} failed, ${envResults.warnings} warnings`);
    process.exit(failed > 0 || !settingsOk ? 1 : 0);
  }

  if (!settingsOk || envResults.failed > 0) {
    log.step('Aborting live analysis due to preflight failures');
    process.exit(1);
  }

  if (imageIssues > 0) {
    log.warn('Some images have issues; attempting analysis on remaining files');
  }

  const outcomes = [];
  for (const image of images) {
    outcomes.push(await analyzeOneImage(image, settings, args.context, args.verbose));
  }

  log.step('Summary');
  const succeeded = outcomes.filter((o) => o.success).length;
  const failed = outcomes.length - succeeded;

  console.log(`  Images analyzed: ${outcomes.length}`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed images:');
    outcomes.forEach((o, i) => {
      if (!o.success) {
        console.log(`  - ${images[i].name}: [${o.category || 'ERROR'}] ${o.error || o.hint || 'unknown'}`);
      }
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nUnexpected diagnostic error:', err);
  process.exit(1);
});
