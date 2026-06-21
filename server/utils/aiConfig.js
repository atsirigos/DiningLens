const AI_PROVIDERS = {
  google: {
    label: 'Google',
    models: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3.0 Flash' },
    ],
  },
  anthropic: {
    label: 'Anthropic',
    models: [
      { id: 'claude-haiku-4-5', label: 'Haiku' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet' },
    ],
  },
};

const DEFAULT_AI = {
  provider: 'google',
  model: 'gemini-2.5-flash',
  apiKey: '',
};

const ENV_KEYS = {
  google: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

function getProviderModels(provider) {
  return AI_PROVIDERS[provider]?.models || [];
}

function resolveApiKey(settings) {
  const key = settings?.ai?.apiKey?.trim();
  if (key && key !== 'your_key_here') return key;

  const provider = settings?.ai?.provider || DEFAULT_AI.provider;
  const envVar = ENV_KEYS[provider] || ENV_KEYS.google;
  const envKey = process.env[envVar]?.trim();
  if (envKey && envKey !== 'your_key_here') return envKey;

  return null;
}

function resolveModel(settings) {
  const provider = settings?.ai?.provider || DEFAULT_AI.provider;
  const model = settings?.ai?.model || DEFAULT_AI.model;
  const valid = getProviderModels(provider).some((m) => m.id === model);
  return valid ? model : getProviderModels(provider)[0]?.id || DEFAULT_AI.model;
}

module.exports = {
  AI_PROVIDERS,
  DEFAULT_AI,
  ENV_KEYS,
  getProviderModels,
  resolveApiKey,
  resolveModel,
};
