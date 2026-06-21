const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

async function analyzeImage(filePath, settings) {
  const provider = settings?.ai?.provider || 'google';
  if (provider !== 'google') {
    throw new Error(`Provider "${provider}" is not supported yet`);
  }

  const apiKey = resolveApiKey(settings);
  if (!apiKey) {
    throw new Error('API key is not configured. Add one in Settings.');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image type: ${ext}`);
  }

  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString('base64');
  const modelId = resolveModel(settings);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelId });

  const prompt = buildPrompt(settings);

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        mimeType,
        data: base64,
      },
    },
  ]);

  const text = result.response.text();
  const parsed = parseJsonResponse(text);

  return parsed;
}

module.exports = { analyzeImage };
