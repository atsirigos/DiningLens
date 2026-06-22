const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveApiKey, resolveModel } = require('./aiConfig');
const { calculateCostUsd } = require('./aiPricing');
const { SYSTEM_PROMPT, buildUserMessage } = require('../prompts/mealAnalysisPrompt');
const { cropAllZones } = require('./zoneCropper');
const { mergeZoneResults } = require('./mergeZoneResults');
const { logApiCall } = require('../db/apiUsageStore');

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function parseJsonResponse(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

function validateMealResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid meal analysis response');
  }
  if (!parsed.meal_name || !Array.isArray(parsed.items) || !parsed.totals) {
    throw new Error('Meal analysis response is missing required fields');
  }
  return parsed;
}

function readImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image type: ${ext}`);
  }

  const base64 = fs.readFileSync(filePath).toString('base64');
  return { mimeType, base64 };
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

async function analyzeImage(filePath, settings, userContext, meta = {}) {
  const filename = meta.filename || path.basename(filePath);
  const callMeta = { filename, zoneName: meta.zoneName };

  const zones = (settings?.zones || []).filter((z) => z?.name);

  if (zones.length === 0) {
    const { mimeType, base64 } = readImage(filePath);
    return analyzeImageData(base64, mimeType, settings, userContext, callMeta);
  }

  const crops = await cropAllZones(filePath, zones);
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

module.exports = { analyzeImage, analyzeImageData };
