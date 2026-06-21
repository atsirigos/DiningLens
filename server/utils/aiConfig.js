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
};

const DEFAULT_AI = {
  provider: 'google',
  model: 'gemini-2.5-flash',
  apiKey: '',
};

function getProviderModels(provider) {
  return AI_PROVIDERS[provider]?.models || [];
}

function resolveApiKey(settings) {
  const key = settings?.ai?.apiKey?.trim();
  if (key && key !== 'your_key_here') return key;

  const envKey = process.env.GEMINI_API_KEY?.trim();
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
  getProviderModels,
  resolveApiKey,
  resolveModel,
};
