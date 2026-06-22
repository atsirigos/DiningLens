import { apiFetch, showToast } from './utils.js';

let settings = {};
let usage = null;

const container = () => document.getElementById('settings-content');

function formatCost(amount) {
  const n = Number(amount) || 0;
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function formatTokens(n) {
  const val = Number(n) || 0;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(val);
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso.includes('T') ? iso : `${iso}Z`).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

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

function renderUsageCard() {
  if (!usage) {
    return `
      <div class="card">
        <h3>API Usage &amp; Spending</h3>
        <p style="margin-top: 1rem; color: var(--color-text-muted); font-size: 0.875rem;">Loading usage data…</p>
      </div>`;
  }

  const byModelRows = (usage.byModel || []).map((row) => `
    <tr>
      <td>${row.provider}</td>
      <td>${row.model}</td>
      <td>${row.calls}</td>
      <td>${formatCost(row.cost_usd)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" style="color: var(--color-text-muted);">No API calls yet</td></tr>';

  const recentRows = (usage.recent || []).slice(0, 10).map((row) => `
    <tr class="${row.success ? '' : 'usage-row-failed'}">
      <td>${formatDateTime(row.createdAt)}</td>
      <td>${row.model}</td>
      <td>${row.zoneName || row.filename || '—'}</td>
      <td>${formatTokens(row.totalTokens)}</td>
      <td>${formatCost(row.estimatedCostUsd)}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" style="color: var(--color-text-muted);">No API calls yet</td></tr>';

  return `
    <div class="card">
      <h3>API Usage &amp; Spending</h3>
      <p style="margin-top: 0.35rem; font-size: 0.875rem; color: var(--color-text-muted);">
        Estimated costs from token usage. Rates are approximate.
      </p>

      <div class="usage-stats-grid">
        <div class="usage-stat">
          <div class="usage-stat-value">${formatCost(usage.totalCostUsd)}</div>
          <div class="usage-stat-label">Total spend</div>
        </div>
        <div class="usage-stat">
          <div class="usage-stat-value">${usage.totalCalls}</div>
          <div class="usage-stat-label">API calls</div>
        </div>
        <div class="usage-stat">
          <div class="usage-stat-value">${formatTokens(usage.totalInputTokens + usage.totalOutputTokens)}</div>
          <div class="usage-stat-label">Tokens</div>
        </div>
      </div>

      <h4 class="usage-section-title">By model</h4>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr><th>Provider</th><th>Model</th><th>Calls</th><th>Cost</th></tr>
          </thead>
          <tbody>${byModelRows}</tbody>
        </table>
      </div>

      <h4 class="usage-section-title">Recent calls</h4>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr><th>When</th><th>Model</th><th>Context</th><th>Tokens</th><th>Cost</th></tr>
          </thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>

      <div class="usage-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="refresh-usage-btn">Refresh</button>
        <button type="button" class="btn btn-ghost btn-sm" id="clear-usage-btn">Clear log</button>
      </div>
    </div>`;
}

function render() {
  const apiKeySet = settings.ai?.apiKeySet;

  container().innerHTML = `
    <div class="settings-ai-grid">
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
        <button class="btn btn-primary" id="save-settings-btn" style="margin-top: 1.25rem;">Save configuration</button>
      </div>

      ${renderUsageCard()}
    </div>`;

  bindEvents();
}

async function loadUsage() {
  try {
    usage = await apiFetch('/api/usage');
    const usageCard = container().querySelector('.settings-ai-grid .card:last-child');
    if (usageCard) {
      const temp = document.createElement('div');
      temp.innerHTML = renderUsageCard();
      usageCard.replaceWith(temp.firstElementChild);
      bindUsageEvents();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function bindUsageEvents() {
  document.getElementById('refresh-usage-btn')?.addEventListener('click', loadUsage);

  document.getElementById('clear-usage-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all API usage history? This cannot be undone.')) return;
    try {
      await apiFetch('/api/usage', { method: 'DELETE' });
      usage = {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        byProvider: [],
        byModel: [],
        recent: [],
      };
      showToast('Usage log cleared', 'info');
      render();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
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
  bindUsageEvents();
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
    showToast('Configuration saved successfully', 'success');
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    [settings, usage] = await Promise.all([
      apiFetch('/api/settings'),
      apiFetch('/api/usage'),
    ]);
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
