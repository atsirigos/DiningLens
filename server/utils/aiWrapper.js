const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveApiKey, resolveModel } = require('./aiConfig');
const { calculateCostUsd } = require('./aiPricing');
const { SYSTEM_PROMPT, buildUserMessage } = require('../prompts/mealAnalysisPrompt');
const { cropAllZones, cropAllZonesFromBuffer } = require('./zoneCropper');
const { mergeZoneResults } = require('./mergeZoneResults');
const { logApiCall } = require('../db/apiUsageStore');
const { extractVideoFrame, DEFAULT_FRAME_TIME_SEC } = require('./videoFrame');

const IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const VIDEO_EXTS = new Set(['.mp4', '.mov']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function parseJsonResponse(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

function normalizeItem(item) {
  const name = String(item?.name || '').trim();
  if (!name) return null;

  const estimated_weight_grams = Number(item.estimated_weight_grams);
  if (!Number.isFinite(estimated_weight_grams) || estimated_weight_grams <= 0) {
    throw new Error(`Item "${name}" must have estimated_weight_grams > 0`);
  }

  const normalized = {
    name,
    estimated_weight_grams,
    is_composite: Boolean(item.is_composite),
  };

  if (item.count != null && item.count !== '') {
    const count = Number(item.count);
    if (Number.isFinite(count) && count > 0) {
      normalized.count = count;
    }
  }

  return normalized;
}

function validateMealResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new Error('Meal analysis response is missing required fields');
  }

  if (parsed.items.length === 0) {
    throw new Error('No food items identified');
  }

  const items = parsed.items.map(normalizeItem).filter(Boolean);
  if (items.length === 0) {
    throw new Error('No valid food items in response');
  }

  return {
    items,
    schema_version: 2,
  };
}

function readImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image type: ${ext}`);
  }

  const base64 = fs.readFileSync(filePath).toString('base64');
  return { mimeType, base64 };
}

function isVideoPath(filePath) {
  return VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
}

function isImagePath(filePath) {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

async function analyzeZonesFromCrops(crops, settings, userContext, filename) {
  if (crops.length === 0) {
    throw new Error('No valid zones configured for cropping');
  }

  const zoneResults = [];
  for (const { zone, image } of crops) {
    const result = await analyzeImageData(
      image.base64,
      image.mimeType,
      settings,
      userContext,
      { filename, zoneName: zone.name },
    );
    zoneResults.push({ zoneName: zone.name, result });
  }

  return mergeZoneResults(zoneResults);
}

/**
 * Analyze a photo or video. Videos extract a frame at meta.frameTimeSec (default 0.5s)
 * and use videoZones only; photos use zones only. Modalities never mix.
 */
async function analyzeMedia(filePath, settings, userContext, meta = {}) {
  const filename = meta.filename || path.basename(filePath);
  const callMeta = { filename, zoneName: meta.zoneName };

  if (isVideoPath(filePath)) {
    const zones = (settings?.videoZones || []).filter((z) => z?.name);
    const frameTimeSec = Number.isFinite(Number(meta.frameTimeSec)) && Number(meta.frameTimeSec) >= 0
      ? Number(meta.frameTimeSec)
      : DEFAULT_FRAME_TIME_SEC;
    const { buffer, mimeType, timeSec } = await extractVideoFrame(filePath, {
      timeSec: frameTimeSec,
    });
    const orientation = settings?.referenceVideoOrientation;

    let result;
    if (zones.length === 0) {
      result = await analyzeImageData(
        buffer.toString('base64'),
        mimeType,
        settings,
        userContext,
        callMeta,
      );
    } else {
      const crops = await cropAllZonesFromBuffer(buffer, zones, orientation);
      result = await analyzeZonesFromCrops(crops, settings, userContext, filename);
    }

    return { ...result, frameTimeSec: timeSec, mediaType: 'video' };
  }

  if (!isImagePath(filePath)) {
    throw new Error(`Unsupported media type: ${path.extname(filePath)}`);
  }

  const zones = (settings?.zones || []).filter((z) => z?.name);

  if (zones.length === 0) {
    const { mimeType, base64 } = readImage(filePath);
    const result = await analyzeImageData(base64, mimeType, settings, userContext, callMeta);
    return { ...result, mediaType: 'image' };
  }

  const crops = await cropAllZones(filePath, zones, settings?.referenceOrientation);
  const result = await analyzeZonesFromCrops(crops, settings, userContext, filename);
  return { ...result, mediaType: 'image' };
}

/** @deprecated Prefer analyzeMedia — kept as alias for photo callers. */
async function analyzeImage(filePath, settings, userContext, meta = {}) {
  return analyzeMedia(filePath, settings, userContext, meta);
}

function recordUsage({ provider, model, meta, usage, success, errorMessage }) {
  const inputTokens = usage?.inputTokens || 0;
  const outputTokens = usage?.outputTokens || 0;
  const estimatedCostUsd = success
    ? calculateCostUsd(model, inputTokens, outputTokens)
    : 0;

  logApiCall({
    provider,
    model,
    filename: meta?.filename,
    zoneName: meta?.zoneName,
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens || inputTokens + outputTokens,
    estimatedCostUsd,
    success,
    errorMessage,
  });
}

async function analyzeWithGoogle(apiKey, modelId, mimeType, base64, userMessage) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction: SYSTEM_PROMPT,
  });

  const result = await model.generateContent([
    userMessage,
    {
      inlineData: {
        mimeType,
        data: base64,
      },
    },
  ]);

  const usageMeta = result.response.usageMetadata || {};
  return {
    text: result.response.text(),
    usage: {
      inputTokens: usageMeta.promptTokenCount || 0,
      outputTokens: usageMeta.candidatesTokenCount || 0,
      totalTokens: usageMeta.totalTokenCount || 0,
    },
  };
}

async function analyzeWithAnthropic(apiKey, modelId, mimeType, base64, userMessage) {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: modelId,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: base64,
            },
          },
          {
            type: 'text',
            text: userMessage,
          },
        ],
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock?.text) {
    throw new Error('No text response from Anthropic');
  }

  return {
    text: textBlock.text,
    usage: {
      inputTokens: message.usage?.input_tokens || 0,
      outputTokens: message.usage?.output_tokens || 0,
      totalTokens: (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0),
    },
  };
}

async function analyzeImageData(base64, mimeType, settings, userContext, meta = {}) {
  const provider = settings?.ai?.provider || 'google';

  const apiKey = resolveApiKey(settings);
  if (!apiKey) {
    throw new Error('API key is not configured. Add one in Settings.');
  }

  const modelId = resolveModel(settings);
  const userMessage = buildUserMessage(userContext);

  let text;
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  try {
    switch (provider) {
      case 'google': {
        const response = await analyzeWithGoogle(apiKey, modelId, mimeType, base64, userMessage);
        text = response.text;
        usage = response.usage;
        break;
      }
      case 'anthropic': {
        const response = await analyzeWithAnthropic(apiKey, modelId, mimeType, base64, userMessage);
        text = response.text;
        usage = response.usage;
        break;
      }
      default:
        throw new Error(`Provider "${provider}" is not supported`);
    }

    recordUsage({ provider, model: modelId, meta, usage, success: true });

    const parsed = parseJsonResponse(text);
    return validateMealResult(parsed);
  } catch (err) {
    recordUsage({
      provider,
      model: modelId,
      meta,
      usage,
      success: false,
      errorMessage: err.message,
    });
    throw err;
  }
}

module.exports = { analyzeImage, analyzeImageData, analyzeMedia };
