const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveApiKey, resolveModel } = require('./aiConfig');
const { SYSTEM_PROMPT, buildUserMessage } = require('../prompts/mealAnalysisPrompt');
const { cropAllZones } = require('./zoneCropper');
const { mergeZoneResults } = require('./mergeZoneResults');

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

  return result.response.text();
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

  return textBlock.text;
}

async function analyzeImageData(base64, mimeType, settings, userContext) {
  const provider = settings?.ai?.provider || 'google';

  const apiKey = resolveApiKey(settings);
  if (!apiKey) {
    throw new Error('API key is not configured. Add one in Settings.');
  }

  const modelId = resolveModel(settings);
  const userMessage = buildUserMessage(userContext);

  let text;
  switch (provider) {
    case 'google':
      text = await analyzeWithGoogle(apiKey, modelId, mimeType, base64, userMessage);
      break;
    case 'anthropic':
      text = await analyzeWithAnthropic(apiKey, modelId, mimeType, base64, userMessage);
      break;
    default:
      throw new Error(`Provider "${provider}" is not supported`);
  }

  const parsed = parseJsonResponse(text);
  return validateMealResult(parsed);
}

async function analyzeImage(filePath, settings, userContext) {
  const zones = (settings?.zones || []).filter((z) => z?.name);

  if (zones.length === 0) {
    const { mimeType, base64 } = readImage(filePath);
    return analyzeImageData(base64, mimeType, settings, userContext);
  }

  const crops = await cropAllZones(filePath, zones);
  if (crops.length === 0) {
    throw new Error('No valid zones configured for cropping');
  }

  const zoneResults = [];
  for (const { zone, image } of crops) {
    const result = await analyzeImageData(image.base64, image.mimeType, settings, userContext);
    zoneResults.push({ zoneName: zone.name, result });
  }

  return mergeZoneResults(zoneResults);
}

module.exports = { analyzeImage, analyzeImageData };
