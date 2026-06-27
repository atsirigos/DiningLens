import { apiFetch, showToast } from './utils.js';

let status = null;
let installing = false;
let installError = null;

const container = () => document.getElementById('phone-content');

function parseHostPort(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return { host: '', port: '' };
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon === -1) return { host: trimmed, port: '' };
  return {
    host: trimmed.slice(0, lastColon),
    port: trimmed.slice(lastColon + 1),
  };
}

function renderAdbStep() {
  if (status?.adbAvailable) {
    return `
      <div class="phone-step card phone-step-done">
        <div class="phone-step-header">
          <span class="phone-step-number">1</span>
          <h3>ADB installed</h3>
          <span class="badge badge-success">Ready</span>
        </div>
        <p class="phone-step-desc">Android Debug Bridge ${status.adbVersion ? `v${status.adbVersion}` : ''} is available on this server.</p>
      </div>`;
  }

  if (installing) {
    return `
      <div class="phone-step card">
        <div class="phone-step-header">
          <span class="phone-step-number">1</span>
          <h3>Setting up ADB…</h3>
        </div>
        <p class="phone-step-desc">
          <span class="loading-spinner phone-inline-spinner"></span>
          Downloading and installing Google's platform-tools. This usually takes 10-30 seconds.
        </p>
      </div>`;
  }

  return `
    <div class="phone-step card">
      <div class="phone-step-header">
        <span class="phone-step-number">1</span>
        <h3>Set up ADB</h3>
      </div>
      <p class="phone-step-desc">
        The app needs Google's platform-tools to talk to your phone. It will download and install them for you automatically — no manual setup required.
      </p>
      <button type="button" class="btn btn-primary btn-sm" id="install-adb-btn">${installError ? 'Retry ADB setup' : 'Install ADB'}</button>
      ${installError ? `<p class="phone-inline-error">${installError}</p>` : ''}
    </div>`;
}

function renderWirelessHelpStep() {
  return `
    <div class="phone-step card ${status?.adbAvailable ? '' : 'phone-step-disabled'}">
      <div class="phone-step-header">
        <span class="phone-step-number">2</span>
        <h3>Enable wireless debugging on your phone</h3>
      </div>
      <details class="phone-details">
        <summary>Show step-by-step instructions</summary>
        <ol class="phone-instructions">
          <li>On your Android phone, open <strong>Settings → About phone</strong> and tap <strong>Build number</strong> 7 times to unlock Developer options.<br>
            <span class="phone-hint">Samsung: About phone → Software information → Build number.</span>
          </li>
          <li>Go to <strong>Settings → Developer options → Wireless debugging</strong> and turn it on.</li>
          <li>Keep this screen open — you'll need pairing and connect addresses in the next steps.</li>
        </ol>
      </details>
    </div>`;
}

function renderPairStep() {
  return `
    <div class="phone-step card ${status?.adbAvailable ? '' : 'phone-step-disabled'}">
      <div class="phone-step-header">
        <span class="phone-step-number">3</span>
        <h3>Pair your phone (one-time)</h3>
      </div>
      <p class="phone-step-desc">
        On the phone, tap <strong>Pair device with pairing code</strong> under Wireless debugging. Enter the IP:port and 6-digit code shown on the phone.
      </p>
      <div class="form-group">
        <label for="pair-address">Pairing address (IP:port)</label>
        <input type="text" id="pair-address" placeholder="e.g. 192.168.1.50:37000">
      </div>
      <div class="form-group">
        <label for="pair-code">6-digit pairing code</label>
        <input type="text" id="pair-code" placeholder="123456" maxlength="6" inputmode="numeric" pattern="[0-9]*">
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="pair-btn" ${status?.adbAvailable ? '' : 'disabled'}>Pair device</button>
      <p id="pair-result" class="phone-step-result" hidden></p>
    </div>`;
}

function renderConnectStep() {
  const savedAddress = status?.address || status?.config?.address || '';
  return `
    <div class="phone-step card ${status?.adbAvailable ? '' : 'phone-step-disabled'}">
      <div class="phone-step-header">
        <span class="phone-step-number">4</span>
        <h3>Connect to your phone</h3>
      </div>
      <p class="phone-step-desc">
        On the <strong>Wireless debugging</strong> main screen (not the pairing dialog), note the <strong>IP address &amp; port</strong> — this is a different port than pairing.
      </p>
      <div class="form-group">
        <label for="connect-address">Connect address (IP:port)</label>
        <input type="text" id="connect-address" placeholder="e.g. 192.168.1.50:41413" value="${savedAddress}">
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="connect-btn" ${status?.adbAvailable ? '' : 'disabled'}>Connect</button>
      <p id="connect-result" class="phone-step-result" hidden></p>
    </div>`;
}

function renderConnectedView() {
  if (!status?.connected) return '';

  return `
    <div class="phone-connected card">
      <div class="phone-connected-header">
        <h3>Phone connected</h3>
        <span class="badge badge-success">Connected</span>
      </div>
      <p class="phone-step-desc">
        Device: <code>${status.connectedDevice || status.address || 'unknown'}</code>
      </p>
      <div class="phone-connected-actions">
        <button type="button" class="btn btn-primary" id="snap-btn">Take test picture</button>
        <button type="button" class="btn btn-ghost btn-sm" id="refresh-status-btn">Refresh status</button>
        <button type="button" class="btn btn-ghost btn-sm" id="disconnect-btn">Disconnect</button>
      </div>
      <p id="snap-status" class="phone-snap-status"></p>
      <img id="snap-preview" class="phone-snap-preview" alt="Test photo preview" hidden>
    </div>`;
}

function renderDeviceList() {
  if (!status?.devices?.length) return '';

  const rows = status.devices.map((d) => `
    <tr>
      <td><code>${d.serial}</code></td>
      <td>${d.state}</td>
    </tr>
  `).join('');

  return `
    <div class="card phone-devices-card">
      <h4 class="phone-section-title">Detected devices</h4>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead><tr><th>Serial</th><th>State</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function render() {
  container().innerHTML = `
    <div class="phone-wizard">
      <div class="phone-notice card">
        <p>
          <strong>Local network only.</strong> Your phone and this computer must be on the same WiFi.
          The server shells out to <code>adb</code> — this does not work from a cloud host that cannot reach your phone.
        </p>
      </div>

      ${renderConnectedView()}

      <div class="phone-steps">
        ${renderAdbStep()}
        ${renderWirelessHelpStep()}
        ${renderPairStep()}
        ${renderConnectStep()}
      </div>

      ${renderDeviceList()}
    </div>`;

  bindEvents();
}

function setStepResult(id, message, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || '';
  el.className = `phone-step-result${isError ? ' phone-inline-error' : ' phone-inline-success'}`;
}

async function loadStatus() {
  status = await apiFetch('/api/phone/status');
}

async function installAdb() {
  if (installing) return;
  installing = true;
  installError = null;
  render();

  try {
    const result = await apiFetch('/api/phone/install-adb', { method: 'POST' });
    showToast(
      result.alreadyInstalled ? 'ADB already installed' : `ADB ${result.version} installed`,
      'success'
    );
    await loadStatus();
  } catch (err) {
    installError = err.message;
    showToast(err.message, 'error');
  } finally {
    installing = false;
    render();
  }
}

function bindEvents() {
  document.getElementById('install-adb-btn')?.addEventListener('click', installAdb);

  document.getElementById('pair-btn')?.addEventListener('click', async () => {
    const address = document.getElementById('pair-address')?.value || '';
    const code = document.getElementById('pair-code')?.value || '';
    const { host, port } = parseHostPort(address);

    if (!host || !port || !code.trim()) {
      setStepResult('pair-result', 'Enter pairing address and 6-digit code.', true);
      return;
    }

    const btn = document.getElementById('pair-btn');
    btn.disabled = true;
    setStepResult('pair-result', 'Pairing…');

    try {
      const result = await apiFetch('/api/phone/pair', {
        method: 'POST',
        body: JSON.stringify({ host, port, code: code.trim() }),
      });
      setStepResult('pair-result', result.message || 'Pairing successful!');
      showToast('Phone paired successfully', 'success');
    } catch (err) {
      setStepResult('pair-result', err.message, true);
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('connect-btn')?.addEventListener('click', async () => {
    const address = document.getElementById('connect-address')?.value || '';
    const { host, port } = parseHostPort(address);

    if (!host || !port) {
      setStepResult('connect-result', 'Enter a valid connect address (IP:port).', true);
      return;
    }

    const btn = document.getElementById('connect-btn');
    btn.disabled = true;
    setStepResult('connect-result', 'Connecting…');

    try {
      const result = await apiFetch('/api/phone/connect', {
        method: 'POST',
        body: JSON.stringify({ host, port }),
      });
      setStepResult('connect-result', result.message || 'Connected!');
      showToast('Phone connected', 'success');
      await loadStatus();
      render();
    } catch (err) {
      setStepResult('connect-result', err.message, true);
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('disconnect-btn')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/phone/disconnect', { method: 'POST' });
      showToast('Phone disconnected', 'info');
      await loadStatus();
      render();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('refresh-status-btn')?.addEventListener('click', async () => {
    try {
      await loadStatus();
      render();
      showToast('Status refreshed', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('snap-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('snap-btn');
    const statusEl = document.getElementById('snap-status');
    const preview = document.getElementById('snap-preview');

    btn.disabled = true;
    statusEl.textContent = 'Opening camera and taking photo… this may take a few seconds.';
    preview.hidden = true;

    try {
      const data = await apiFetch('/api/camera/snap', { method: 'POST' });
      preview.src = `${data.url}?t=${Date.now()}`;
      preview.hidden = false;
      statusEl.textContent = `Saved: ${data.file}`;
      showToast('Test picture captured', 'success');
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

export async function init() {
  container().innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    await loadStatus();
    render();
    if (!status?.adbAvailable && !installing && !installError) {
      installAdb();
    }
  } catch (err) {
    container().innerHTML = `
      <div class="empty-state">
        <h3>Failed to load phone configuration</h3>
        <p>${err.message}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  init();
}
