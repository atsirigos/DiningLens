const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveApiKey, resolveModel } = require('./aiConfig');

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function buildPrompt(settings) {
  const zones = settings.zones || [];
  const commonFoods = settings.commonFoods || [];

  const zoneList = zones.length
    ? zones.map((z) => `- "${z.name}" (region: x=${z.x.toFixed(2)}, y=${z.y.toFixed(2)}, w=${z.width.toFixed(2)}, h=${z.height.toFixed(2)})`).join('\n')
    : '- Analyze the entire image as one zone called "Full Table"';

  const foodsHint = commonFoods.length
    ? `\nCommon foods to look for: ${commonFoods.join(', ')}.`
    : '';

  return `Analyze this meal photo. For each defined zone, identify food items present.

Defined zones (coordinates are normalized 0-1 relative to image dimensions):
${zoneList}
${foodsHint}

Return JSON only, no markdown. Use this exact schema:
{
  "zones": [
    {
      "name": "zone name",
      "foods": [
        {
          "item": "food name",
          "ingredients": ["ingredient1", "ingredient2"],
          "portion": "small|medium|large"
        }
      ]
    }
  ]
}

If no zones are defined, analyze the full image as a single zone.`;
}

function parseJsonResponse(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
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

async function analyzeWithGoogle(apiKey, modelId, mimeType, base64, prompt) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelId });

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        mimeType,
        data: base64,
      },
    },
  ]);

  return result.response.text();
}

async function analyzeWithAnthropic(apiKey, modelId, mimeType, base64, prompt) {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
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
            text: prompt,
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

async function analyzeImage(filePath, settings) {
  const provider = settings?.ai?.provider || 'google';

  const apiKey = resolveApiKey(settings);
  if (!apiKey) {
    throw new Error('API key is not configured. Add one in Settings.');
  }

  const { mimeType, base64 } = readImage(filePath);
  const modelId = resolveModel(settings);
  const prompt = buildPrompt(settings);

  let text;
  switch (provider) {
    case 'google':
      text = await analyzeWithGoogle(apiKey, modelId, mimeType, base64, prompt);
      break;
    case 'anthropic':
      text = await analyzeWithAnthropic(apiKey, modelId, mimeType, base64, prompt);
      break;
    default:
      throw new Error(`Provider "${provider}" is not supported`);
  }

  return parseJsonResponse(text);
}

module.exports = { analyzeImage };
