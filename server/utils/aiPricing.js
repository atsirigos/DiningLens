/**
 * Estimated USD pricing per 1M tokens (input / output).
 * Update these rates when provider pricing changes.
 */
const MODEL_PRICING = {
  'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-2.5-flash': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10.00 },
  'gemini-3-flash-preview': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'claude-haiku-4-5': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-sonnet-4-6': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
};

const DEFAULT_RATES = { inputPerMillion: 1.0, outputPerMillion: 3.0 };

function getModelRates(modelId) {
  return MODEL_PRICING[modelId] || DEFAULT_RATES;
}

function calculateCostUsd(modelId, inputTokens, outputTokens) {
  const rates = getModelRates(modelId);
  const input = (Number(inputTokens) || 0) / 1_000_000 * rates.inputPerMillion;
  const output = (Number(outputTokens) || 0) / 1_000_000 * rates.outputPerMillion;
  return input + output;
}

function formatCostUsd(amount) {
  const n = Number(amount) || 0;
  if (n === 0) return '$0.00';
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

module.exports = {
  MODEL_PRICING,
  calculateCostUsd,
  formatCostUsd,
};
