import { apiFetch, showToast } from './utils.js';

let status = null;
let installing = false;
let installError = null;
let addMethod = 'wifi';
let pollTimer = null;
let renamingDeviceId = null;

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stateBadge(state) {
  if (state === 'device') return '<span class="badge badge-success">Connected</span>';
  if (state === 'unauthorized') return '<span class="badge badge-warning">Unauthorized</span>';
  if (state === 'offline') return '<span class="badge badge-muted">Offline</span>';
  return `<span class="badge badge-muted">${escapeHtml(state || 'unknown')}</span>`;
}

function connectionLabel(type) {
  return type === 'usb' ? 'USB' : 'Wi-Fi';
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
      ${installError ? `<p class="phone-inline-error">${escapeHtml(installError)}</p>` : ''}
    </div>`;
}

function renderDebugHelpStep() {
  return `
    <div class="phone-step card ${status?.adbAvailable ? '' : 'phone-step-disabled'}">
      <div class="phone-step-header">
        <span class="phone-step-number">2</span>
        <h3>Enable debugging on your phone</h3>
      </div>
      <details class="phone-details">
        <summary>Show step-by-step instructions</summary>
        <div class="phone-instruction-groups">
          <div class="phone-instruction-group">
            <h4>USB debugging</h4>
            <ol class="phone-instructions">
              <li>On your Android phone, open <strong>Settings → About phone</strong> and tap <strong>Build number</strong> 7 times to unlock Developer options.<br>
                <span class="phone-hint">Samsung: About phone → Software information → Build number.</span>
              </li>
              <li>Go to <strong>Settings → Developer options</strong> and turn on <strong>USB debugging</strong>.</li>
              <li>Connect the phone to this computer with a USB cable.</li>
              <li>When prompted on the phone, tap <strong>Allow</strong> for USB debugging.</li>
            </ol>
          </div>
          <div class="phone-instruction-group">
            <h4>Wi-Fi debugging</h4>
            <ol class="phone-instructions">
              <li>Enable Developer options as above.</li>
              <li>Go to <strong>Settings → Developer options → Wireless debugging</strong> and turn it on.</li>
              <li>Keep this screen open — you'll need pairing and connect addresses when adding a Wi-Fi device.</li>
            </ol>
          </div>
        </div>
      </details>
    </div>`;
}

function renderAddDeviceSection() {
  const disabled = !status?.adbAvailable;

  return `
    <div class="phone-step card phone-add-device ${disabled ? 'phone-step-disabled' : ''}">
      <div class="phone-step-header">
        <span class="phone-step-number">3</span>
        <h3>Add a device</h3>
      </div>

      <div class="phone-method-toggle" role="tablist" aria-label="Connection method">
        <button type="button" class="phone-method-btn ${addMethod === 'wifi' ? 'active' : ''}" data-method="wifi" ${disabled ? 'disabled' : ''}>Wi-Fi</button>
        <button type="button" class="phone-method-btn ${addMethod === 'usb' ? 'active' : ''}" data-method="usb" ${disabled ? 'disabled' : ''}>USB</button>
      </div>

      ${addMethod === 'wifi' ? renderWifiAddForm() : renderUsbAddForm()}
    </div>`;
}

function renderWifiAddForm() {
  const savedAddress = status?.address || status?.config?.address || '';

  return `
    <div class="phone-add-form">
      <p class="phone-step-desc">
        Pair once, then connect using the main wireless debugging address (different port than pairing).
      </p>

      <div class="form-group">
        <label for="device-name-wifi">Device name</label>
        <input type="text" id="device-name-wifi" placeholder="e.g. Kitchen phone">
      </div>

      <div class="phone-wifi-subsection">
        <h4 class="phone-subsection-title">Pair (one-time)</h4>
        <div class="form-group">
          <label for="pair-address">Pairing address (IP:port)</label>
          <input type="text" id="pair-address" placeholder="e.g. 192.168.1.50:37000">
        </div>
        <div class="form-group">
          <label for="pair-code">6-digit pairing code</label>
          <input type="text" id="pair-code" placeholder="123456" maxlength="6" inputmode="numeric" pattern="[0-9]*">
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="pair-btn">Pair device</button>
        <p id="pair-result" class="phone-step-result" hidden></p>
      </div>

      <div class="phone-wifi-subsection">
        <h4 class="phone-subsection-title">Connect &amp; save</h4>
        <div class="form-group">
          <label for="connect-address">Connect address (IP:port)</label>
          <input type="text" id="connect-address" placeholder="e.g. 192.168.1.50:41413" value="${escapeHtml(savedAddress)}">
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="connect-btn">Connect &amp; add device</button>
        <p id="connect-result" class="phone-step-result" hidden></p>
      </div>
    </div>`;
}

function renderUsbAddForm() {
  const detected = (status?.detectedDevices || []).filter((d) => d.connectionType === 'usb');

  const detectedHtml = detected.length
    ? detected.map((d) => {
      const suggestedName = d.model || d.serial;
      const canAdd = d.liveState === 'device';
      const hint = d.liveState === 'unauthorized'
        ? 'Tap <strong>Allow</strong> on your phone\'s USB debugging prompt.'
        : canAdd
          ? 'Ready to add.'
          : 'Waiting for device authorization…';

      return `
        <div class="phone-detected-item" data-serial="${escapeHtml(d.serial)}">
          <div class="phone-detected-info">
            <strong>${escapeHtml(suggestedName)}</strong>
            <code>${escapeHtml(d.serial)}</code>
            ${stateBadge(d.liveState)}
          </div>
          <p class="phone-detected-hint">${hint}</p>
          <div class="phone-detected-actions">
            <input type="text" class="phone-detected-name" placeholder="Device name" value="${escapeHtml(suggestedName)}" ${canAdd ? '' : 'disabled'}>
            <button type="button" class="btn btn-primary btn-sm phone-add-usb-btn" data-serial="${escapeHtml(d.serial)}" ${canAdd ? '' : 'disabled'}>Add device</button>
          </div>
        </div>`;
    }).join('')
    : `
      <div class="phone-detected-empty">
        <span class="loading-spinner phone-inline-spinner"></span>
        Waiting for a USB device… plug in your phone and allow USB debugging.
      </div>`;

  return `
    <div class="phone-add-form">
      <p class="phone-step-desc">
        Plug in your phone via USB. This page auto-detects new devices every few seconds.
      </p>
      <div class="phone-detected-list">${detectedHtml}</div>
    </div>`;
}

function renderRegisteredDevices() {
  const devices = status?.registeredDevices || [];

  if (!devices.length) {
    return `
      <div class="card phone-devices-card">
        <h4 class="phone-section-title">Registered devices</h4>
        <p class="phone-step-desc">No devices registered yet. Add one using Wi-Fi or USB above.</p>
      </div>`;
  }

  const rows = devices.map((d) => {
    const isDefault = d.id === status?.defaultDeviceId;
    const isActive = d.id === (status?.activeDeviceId || status?.defaultDeviceId);
    const isRenaming = renamingDeviceId === d.id;

    const badges = [
      isDefault ? '<span class="badge badge-info">Default</span>' : '',
      isActive ? '<span class="badge badge-accent">Active</span>' : '',
      stateBadge(d.liveState),
    ].filter(Boolean).join(' ');

    const nameCell = isRenaming
      ? `<input type="text" class="phone-rename-input" id="rename-input-${d.id}" value="${escapeHtml(d.name)}">`
      : `<strong>${escapeHtml(d.name)}</strong>`;

    const actions = isRenaming
      ? `
        <button type="button" class="btn btn-primary btn-sm" data-action="save-rename" data-id="${d.id}">Save</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-rename">Cancel</button>`
      : `
        ${!isActive ? `<button type="button" class="btn btn-ghost btn-sm" data-action="set-active" data-id="${d.id}">Set active</button>` : ''}
        ${!isDefault ? `<button type="button" class="btn btn-ghost btn-sm" data-action="set-default" data-id="${d.id}">Set default</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-action="rename" data-id="${d.id}">Rename</button>
        <button type="button" class="btn btn-ghost btn-sm phone-danger-btn" data-action="remove" data-id="${d.id}">Remove</button>`;

    return `
      <tr class="phone-device-row ${isActive ? 'phone-device-row-active' : ''}">
        <td>${nameCell}</td>
        <td>${connectionLabel(d.connectionType)}</td>
        <td><code>${escapeHtml(d.connectionType === 'wifi' ? (d.address || d.serial) : d.serial)}</code></td>
        <td><div class="phone-device-badges">${badges}</div></td>
        <td><div class="phone-device-actions">${actions}</div></td>
      </tr>`;
  }).join('');

  return `
    <div class="card phone-devices-card">
      <div class="phone-devices-header">
        <h4 class="phone-section-title">Registered devices</h4>
        <button type="button" class="btn btn-ghost btn-sm" id="refresh-status-btn">Refresh</button>
      </div>
      <div class="usage-table-wrap">
        <table class="usage-table phone-device-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Address / Serial</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function renderChargeControlCard() {
  if (!status?.activeDevice) return '';

  const cc = status?.config?.chargeControl || { enabled: true, stopAt: 80, startAt: 20 };

  return `
    <div class="card phone-charge-control-card">
      <h4 class="phone-section-title">Battery charge limits</h4>
      <p class="phone-step-desc">
        When the active phone is plugged in, charging stops at the upper limit and resumes at the lower limit.
        Most Samsung devices need root access for this to work.
      </p>
      <label class="phone-charge-toggle">
        <input type="checkbox" id="phone-charge-enabled" ${cc.enabled ? 'checked' : ''}>
        <span>Enable charge control</span>
      </label>
      <div class="phone-charge-fields">
        <label class="phone-charge-field">
          <span>Stop charging at</span>
          <input type="number" id="phone-charge-stop" min="2" max="100" step="1" value="${cc.stopAt}">
          <span>%</span>
        </label>
        <label class="phone-charge-field">
          <span>Start charging at</span>
          <input type="number" id="phone-charge-start" min="1" max="99" step="1" value="${cc.startAt}">
          <span>%</span>
        </label>
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="phone-charge-save-btn">Save charge limits</button>
      <p id="phone-charge-save-result" class="phone-step-result" hidden></p>
    </div>`;
}

function renderConnectedView() {
  const active = status?.activeDevice;
  if (!active) return '';

  const connected = active.connected || status?.connected;

  return `
    <div class="phone-connected card">
      <div class="phone-connected-header">
        <h3>${connected ? 'Active device ready' : 'Active device offline'}</h3>
        <span class="badge ${connected ? 'badge-success' : 'badge-muted'}">${connected ? 'Connected' : 'Offline'}</span>
      </div>
      <p class="phone-step-desc">
        <strong>${escapeHtml(active.name)}</strong>
        (${connectionLabel(active.connectionType)})
        — <code>${escapeHtml(active.connectionType === 'wifi' ? (active.address || active.serial) : active.serial)}</code>
      </p>
      <div class="phone-connected-actions">
        <button type="button" class="btn btn-primary" id="snap-btn" ${connected ? '' : 'disabled'}>Take test picture</button>
        <button type="button" class="btn btn-ghost btn-sm" id="disconnect-wifi-btn" ${active.connectionType === 'wifi' && connected ? '' : 'hidden'}>Disconnect Wi-Fi</button>
      </div>
      <p id="snap-status" class="phone-snap-status"></p>
      <img id="snap-preview" class="phone-snap-preview" alt="Test photo preview" hidden>
    </div>`;
}

function render() {
  container().innerHTML = `
    <div class="phone-wizard">
      <div class="phone-notice card">
        <p>
          <strong>Local connection only.</strong> USB devices plug directly into this computer.
          Wi-Fi devices must be on the same network. The server shells out to <code>adb</code> — this does not work from a cloud host.
        </p>
      </div>

      ${renderConnectedView()}
      ${renderChargeControlCard()}

      <div class="phone-steps">
        ${renderAdbStep()}
        ${renderDebugHelpStep()}
        ${renderAddDeviceSection()}
      </div>

      ${renderRegisteredDevices()}
    </div>`;

  bindEvents();
  syncPolling();
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

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function syncPolling() {
  stopPolling();
  if (addMethod === 'usb' && status?.adbAvailable) {
    pollTimer = setInterval(async () => {
      try {
        await loadStatus();

        const detectedContainer = container()?.querySelector('.phone-detected-list');
        const devicesCard = container()?.querySelector('.phone-devices-card');
        const connectedCard = container()?.querySelector('.phone-connected');

        if (detectedContainer) {
          const temp = document.createElement('div');
          temp.innerHTML = renderUsbAddForm();
          const newList = temp.querySelector('.phone-detected-list');
          if (newList) detectedContainer.innerHTML = newList.innerHTML;
          bindUsbDetectEvents();
        }

        if (devicesCard) {
          const temp = document.createElement('div');
          temp.innerHTML = renderRegisteredDevices();
          const newCard = temp.firstElementChild;
          if (newCard) {
            devicesCard.replaceWith(newCard);
            bindDeviceTableEvents();
          }
        }

        if (connectedCard) {
          const temp = document.createElement('div');
          temp.innerHTML = renderConnectedView();
          const newConnected = temp.firstElementChild;
          if (newConnected) {
            connectedCard.replaceWith(newConnected);
            bindSnapEvents();
          } else {
            connectedCard.remove();
          }
        } else {
          const temp = document.createElement('div');
          temp.innerHTML = renderConnectedView();
          const newConnected = temp.firstElementChild;
          if (newConnected) {
            container()?.querySelector('.phone-wizard')?.insertAdjacentElement('afterbegin', newConnected);
            bindSnapEvents();
          }
        }
      } catch {
        /* ignore polling errors */
      }
    }, 2000);
  }
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

async function registerDevice({ name, connectionType, serial, address }) {
  return apiFetch('/api/phone/devices', {
    method: 'POST',
    body: JSON.stringify({ name, connectionType, serial, address }),
  });
}

async function setActiveDevice(id) {
  await apiFetch('/api/phone/active', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
  showToast('Active device updated', 'success');
  await loadStatus();
  render();
}

async function setDefaultDevice(id) {
  await apiFetch(`/api/phone/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ makeDefault: true }),
  });
  showToast('Default device updated', 'success');
  await loadStatus();
  render();
}

async function renameDevice(id, name) {
  await apiFetch(`/api/phone/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  renamingDeviceId = null;
  showToast('Device renamed', 'success');
  await loadStatus();
  render();
}

async function removeDevice(id) {
  const device = status?.registeredDevices?.find((d) => d.id === id);
  const label = device?.name || 'this device';
  if (!window.confirm(`Remove "${label}" from registered devices?`)) return;

  await apiFetch(`/api/phone/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  showToast('Device removed', 'info');
  await loadStatus();
  render();
}

function bindUsbDetectEvents() {
  container()?.querySelectorAll('.phone-add-usb-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const serial = btn.dataset.serial;
      const item = btn.closest('.phone-detected-item');
      const nameInput = item?.querySelector('.phone-detected-name');
      const name = nameInput?.value?.trim();

      if (!name) {
        showToast('Enter a device name', 'error');
        return;
      }

      btn.disabled = true;
      try {
        await registerDevice({ name, connectionType: 'usb', serial });
        showToast(`"${name}" added`, 'success');
        await loadStatus();
        render();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

function bindDeviceTableEvents() {
  container()?.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      try {
        if (action === 'set-active') await setActiveDevice(id);
        else if (action === 'set-default') await setDefaultDevice(id);
        else if (action === 'rename') {
          renamingDeviceId = id;
          render();
        } else if (action === 'cancel-rename') {
          renamingDeviceId = null;
          render();
        } else if (action === 'save-rename') {
          const input = document.getElementById(`rename-input-${id}`);
          const name = input?.value?.trim();
          if (!name) {
            showToast('Name cannot be empty', 'error');
            return;
          }
          await renameDevice(id, name);
        } else if (action === 'remove') {
          await removeDevice(id);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function bindSnapEvents() {
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
      statusEl.textContent = `Saved: ${data.file}${data.deviceName ? ` (${data.deviceName})` : ''}`;
      showToast('Test picture captured', 'success');
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('disconnect-wifi-btn')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/phone/disconnect', { method: 'POST' });
      showToast('Wi-Fi devices disconnected', 'info');
      await loadStatus();
      render();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function bindChargeControlEvents() {
  document.getElementById('phone-charge-save-btn')?.addEventListener('click', async () => {
    const enabled = document.getElementById('phone-charge-enabled')?.checked ?? true;
    const stopAt = Number(document.getElementById('phone-charge-stop')?.value);
    const startAt = Number(document.getElementById('phone-charge-start')?.value);

    const btn = document.getElementById('phone-charge-save-btn');
    btn.disabled = true;
    setStepResult('phone-charge-save-result', 'Saving…');

    try {
      const result = await apiFetch('/api/phone/config', {
        method: 'POST',
        body: JSON.stringify({
          chargeControl: { enabled, stopAt, startAt },
        }),
      });
      if (status) {
        status.config = { ...status.config, chargeControl: result.config.chargeControl };
      }
      setStepResult('phone-charge-save-result', 'Charge limits saved.');
      showToast('Charge limits saved', 'success');
    } catch (err) {
      setStepResult('phone-charge-save-result', err.message, true);
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function bindEvents() {
  document.getElementById('install-adb-btn')?.addEventListener('click', installAdb);

  container()?.querySelectorAll('.phone-method-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      addMethod = btn.dataset.method;
      render();
    });
  });

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
    const name = document.getElementById('device-name-wifi')?.value?.trim() || '';
    const { host, port } = parseHostPort(address);

    if (!host || !port) {
      setStepResult('connect-result', 'Enter a valid connect address (IP:port).', true);
      return;
    }

    if (!name) {
      setStepResult('connect-result', 'Enter a device name.', true);
      return;
    }

    const btn = document.getElementById('connect-btn');
    btn.disabled = true;
    setStepResult('connect-result', 'Connecting…');

    try {
      const result = await apiFetch('/api/phone/connect', {
        method: 'POST',
        body: JSON.stringify({ host, port, name }),
      });
      setStepResult('connect-result', result.message || 'Connected and saved!');
      showToast(`"${name}" connected and added`, 'success');
      await loadStatus();
      render();
    } catch (err) {
      setStepResult('connect-result', err.message, true);
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
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

  bindUsbDetectEvents();
  bindDeviceTableEvents();
  bindSnapEvents();
  bindChargeControlEvents();
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
        <p>${escapeHtml(err.message)}</p>
      </div>`;
    showToast(err.message, 'error');
  }
}

export function refresh() {
  stopPolling();
  init();
}

export function destroy() {
  stopPolling();
}
