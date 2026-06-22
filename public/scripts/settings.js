import { apiFetch, showToast } from './utils.js';

let settings = {};

const container = () => document.getElementById('settings-content');

function renderModelOptions() {
  const provider = settings.ai?.provider || 'google';
  const models = settings.aiProviders?.[provider]?.models || [];
  const selected = settings.ai?.model || models[0]?.id || '';

  return models.map((m) => `
    <option value="${m.id}" ${selected === m.id ? 'selected' : ''}>${m.label}</option>
  `).join('');
}

function renderProviderOptions() {
  const providers = settings.aiProviders || { google: { label: 'Google' } };
  const selected = settings.ai?.provider || 'google';

  return Object.entries(providers).map(([id, p]) => `
    <option value="${id}" ${selected === id ? 'selected' : ''}>${p.label}</option>
  `).join('');
}

function render() {
  const apiKeySet = settings.ai?.apiKeySet;

  container().innerHTML = `
    <div style="max-width: 520px;">
      <div class="card">
        <h3>AI Configuration</h3>
        <p style="margin-top: 0.35rem; font-size: 0.875rem; color: var(--color-text-muted);">
          Choose your AI provider and model for meal photo analysis.
        </p>
        <div class="form-group" style="margin-top: 1rem;">
          <label for="ai-provider">Provider</label>
          <select id="ai-provider">${renderProviderOptions()}</select>
        </div>
        <div class="form-group">
          <label for="ai-model">Model</label>
          <select id="ai-model">${renderModelOptions()}</select>
        </div>
        <div class="form-group">
          <label for="api-key">API Key</label>
          <div class="api-key-row">
            <input
              type="password"
              id="api-key"
              placeholder="${apiKeySet ? 'Key saved — enter new value to replace' : 'Enter your API key'}"
              autocomplete="off"
            >
            <button type="button" class="btn btn-ghost btn-sm" id="toggle-api-key" aria-label="Show API key">Show</button>
          </div>
          ${apiKeySet ? '<p class="api-key-hint"><span class="badge badge-success">Configured</span></p>' : ''}
        </div>
      </div>
      <button class="btn btn-primary" id="save-settings-btn" style="margin-top: 1.5rem;">Save Settings</button>
    </div>`;

  bindEvents();
}

function bindEvents() {
  document.getElementById('ai-provider')?.addEventListener('change', (e) => {
    if (!settings.ai) settings.ai = {};
    settings.ai.provider = e.target.value;

    const models = settings.aiProviders?.[settings.ai.provider]?.models || [];
    settings.ai.model = models[0]?.id || '';

    const modelSelect = document.getElementById('ai-model');
    if (modelSelect) {
      modelSelect.innerHTML = models.map((m) => `
        <option value="${m.id}" ${settings.ai.model === m.id ? 'selected' : ''}>${m.label}</option>
      `).join('');
    }
  });

  document.getElementById('ai-model')?.addEventListener('change', (e) => {
    if (!settings.ai) settings.ai = {};
    settings.ai.model = e.target.value;
  });

  document.getElementById('toggle-api-key')?.addEventListener('click', () => {
    const input = document.getElementById('api-key');
    const btn = document.getElementById('toggle-api-key');
    if (!input || !btn) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });

  document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
}

async function saveSettings() {
  try {
    const payload = {
      zones: settings.zones,
      referenceImage: settings.referenceImage,
      ai: {
        provider: document.getElementById('ai-provider')?.value || settings.ai?.provider || 'google',
        model: document.getElementById('ai-model')?.value || settings.ai?.model || 'gemini-2.5-flash',
      },
    };

    const apiKey = document.getElementById('api-key')?.value.trim();
    if (apiKey) {
      payload.ai.apiKey = apiKey;
    }

    settings = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const apiKeyInput = document.getElementById('api-key');
    if (apiKeyInput) apiKeyInput.value = '';
    showToast('Settings saved successfully', 'success');
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    settings = await apiFetch('/api/settings');
    render();
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <h3>Failed to load settings</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}
