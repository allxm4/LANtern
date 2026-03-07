'use strict';

let devices = [];
let editingId = null;
let sessionToken = null;
let pinEnabled = false;

const TOKEN_KEY = 'LANtern_token';
const TOKEN_EXP_KEY = 'LANtern_token_exp';
const SESSION_CLIENT_HOURS = 8;

function getStoredToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const exp = parseInt(localStorage.getItem(TOKEN_EXP_KEY) || '0');
  if (!token || Date.now() > exp) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    return null;
  }
  return token;
}

function storeToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXP_KEY, String(Date.now() + SESSION_CLIENT_HOURS * 3600_000));
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
  sessionToken = null;
}

async function apiFetch(url, options = {}) {
  const headers = {
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    await showPinScreen();
    return null;
  }
  return res;
}

async function init() {
  applyTheme(getSavedTheme());
  await checkAuth();
  bindEvents();
  registerSW();
}

async function checkAuth() {
  sessionToken = getStoredToken();

  const res = await fetch('/api/auth/status', {
    headers: sessionToken ? { 'x-session-token': sessionToken } : {},
  });
  const status = await res.json();
  pinEnabled = status.pinEnabled;

  if (!status.authenticated) {
    await showPinScreen();
    return;
  }

  revealApp();
  await fetchDevices();
}

let pinBuffer = '';

async function showPinScreen() {
  pinBuffer = '';
  document.getElementById('pinError').textContent = '';
  document.getElementById('app').style.display = 'none';
  updatePinDots();
  const screen = document.getElementById('pinScreen');
  screen.style.display = 'flex';
}

function revealApp() {
  document.getElementById('pinScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('lockBtn').style.display = pinEnabled ? '' : 'none';
}

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dot');
  dots.forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
}

function appendPinDigit(d) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d;
  updatePinDots();
  if (pinBuffer.length === 4) submitPin();
}

function deletePinDigit() {
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
  document.getElementById('pinError').textContent = '';
  document.getElementById('pinDots').classList.remove('error');
}

async function submitPin() {
  const pin = pinBuffer;
  pinBuffer = '';
  updatePinDots();

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });

  const data = await res.json();

  if (res.ok) {
    storeToken(data.token);
    sessionToken = data.token;
    document.getElementById('pinError').textContent = '';
    revealApp();
    await fetchDevices();
  } else {
    const dots = document.getElementById('pinDots');
    dots.classList.add('error', 'shake');
    setTimeout(() => dots.classList.remove('shake', 'error'), 500);

    const errEl = document.getElementById('pinError');
    if (data.locked) {
      errEl.textContent = data.error;
    } else if (data.attemptsLeft !== undefined) {
      errEl.textContent = `Incorrect PIN. ${data.attemptsLeft} attempt${data.attemptsLeft !== 1 ? 's' : ''} left`;
    } else {
      errEl.textContent = data.error || 'Incorrect PIN';
    }
  }
}

async function lockApp() {
  if (sessionToken) {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-session-token': sessionToken },
    });
  }
  clearToken();
  await showPinScreen();
}

async function fetchDevices() {
  const res = await apiFetch('/api/devices');
  if (!res) return;
  if (!res.ok) { showToast('Failed to load devices', 'error'); return; }
  devices = await res.json();
  renderDevices();
}

function renderDevices() {
  const grid = document.getElementById('deviceGrid');
  const empty = document.getElementById('emptyState');

  if (!devices.length) {
    grid.style.display = 'none';
    empty.style.display = '';
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';
  grid.innerHTML = devices.map(deviceCard).join('');
}

function deviceCard(d) {
  const lastWake = getLastWake(d.id);
  const lastWakeHtml = lastWake ? `<p class="device-last-wake">Last woken ${relativeTime(lastWake)}</p>` : '';
  const ipHtml = d.ip
    ? `<div class="device-detail">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
        <span>${esc(d.ip)}</span>
      </div>`
    : '';

  return `
    <article class="device-card" data-id="${d.id}">
      <div class="device-meta">
        <h3 class="device-name">${esc(d.name)}</h3>
        <div class="device-detail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <span>${esc(d.mac)}</span>
        </div>
        ${ipHtml}
        ${lastWakeHtml}
      </div>
      <div class="card-bottom">
        <div class="card-actions">
          <button class="btn-icon btn-edit" data-id="${d.id}" title="Edit ${esc(d.name)}" aria-label="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn-icon btn-delete" data-id="${d.id}" title="Remove ${esc(d.name)}" aria-label="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>
        <button class="power-btn" data-id="${d.id}" title="Wake ${esc(d.name)}" aria-label="Wake ${esc(d.name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <path d="M12 3v9"/>
            <path d="M7.5 5.6C5.6 6.9 4.3 9 4.3 11.3c0 4.3 3.3 7.7 7.7 7.7s7.7-3.4 7.7-7.7c0-2.3-1.3-4.4-3.2-5.7"/>
          </svg>
        </button>
      </div>
    </article>`;
}

async function wakeDevice(id) {
  const device = devices.find((d) => d.id === id);
  if (!device) return;

  const btn = document.querySelector(`.power-btn[data-id="${id}"]`);
  if (!btn || btn.classList.contains('sending')) return;
  btn.classList.add('sending');

  const res = await apiFetch(`/api/wake/${id}`, { method: 'POST' });
  btn.classList.remove('sending');

  if (!res) return;
  const data = await res.json();

  if (res.ok) {
    btn.classList.add('success');
    saveLastWake(id);
    updateLastWakeDisplay(id);
    showToast(`Magic packet sent to ${device.name}`, 'success');
  } else {
    btn.classList.add('error');
    showToast(data.error || 'Failed to send packet', 'error');
  }

  setTimeout(() => btn.classList.remove('success', 'error'), 2200);
}

function openDeviceModal(device = null) {
  editingId = device?.id || null;
  document.getElementById('modalTitle').textContent = device ? 'Edit Device' : 'Add Device';
  document.getElementById('saveBtn').textContent = device ? 'Update Device' : 'Save Device';
  document.getElementById('deviceName').value = device?.name || '';
  document.getElementById('deviceMAC').value = device?.mac || '';
  document.getElementById('deviceIP').value = device?.ip || '';
  document.getElementById('deviceBroadcast').value =
    device?.broadcastAddress && device.broadcastAddress !== '255.255.255.255'
      ? device.broadcastAddress
      : '';

  ['deviceName', 'deviceMAC'].forEach((id) => document.getElementById(id).classList.remove('invalid'));

  openOverlay('modal');
  setTimeout(() => document.getElementById('deviceName').focus(), 50);
}

function closeDeviceModal() {
  closeOverlay('modal');
  setTimeout(() => { document.getElementById('deviceForm').reset(); editingId = null; }, 300);
}

async function submitDevice(e) {
  e.preventDefault();
  const name = document.getElementById('deviceName').value.trim();
  const mac = document.getElementById('deviceMAC').value.trim();
  const ip = document.getElementById('deviceIP').value.trim();
  const broadcastAddress = document.getElementById('deviceBroadcast').value.trim() || '255.255.255.255';

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;

  const res = await apiFetch(
    editingId ? `/api/devices/${editingId}` : '/api/devices',
    { method: editingId ? 'PUT' : 'POST', body: JSON.stringify({ name, mac, ip, broadcastAddress }) }
  );

  saveBtn.disabled = false;
  if (!res) return;

  const data = await res.json();
  if (res.ok) {
    closeDeviceModal();
    await fetchDevices();
    showToast(editingId ? 'Device updated' : 'Device added', 'success');
  } else {
    showToast(data.error || 'Failed to save device', 'error');
    if (data.error?.toLowerCase().includes('mac')) {
      document.getElementById('deviceMAC').classList.add('invalid');
    }
  }
}

function confirmDelete(id) {
  const device = devices.find((d) => d.id === id);
  if (!device) return;
  document.getElementById('confirmMessage').textContent = `"${device.name}" will be removed from your device list.`;

  openOverlay('confirmOverlay');
  document.getElementById('confirmOk').onclick = async () => { closeOverlay('confirmOverlay'); await deleteDevice(id); };
  document.getElementById('confirmCancel').onclick = () => closeOverlay('confirmOverlay');
}

async function deleteDevice(id) {
  const res = await apiFetch(`/api/devices/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (res.ok) { await fetchDevices(); showToast('Device removed', 'success'); }
  else showToast('Failed to remove device', 'error');
}

function openSettings() {
  refreshSettingsUI();
  openOverlay('settingsModal');
}

function refreshSettingsUI() {
  const statusText = document.getElementById('pinStatusText');
  const setForm = document.getElementById('setPinForm');
  const changeForm = document.getElementById('changePinForm');

  if (pinEnabled) {
    statusText.textContent = 'PIN lock is active. Anyone accessing this app will be prompted for the PIN.';
    setForm.style.display = 'none';
    changeForm.style.display = 'block';
    changeForm.reset();
    ['currentPin', 'newPinChange', 'confirmPinChange'].forEach((id) =>
      document.getElementById(id).classList.remove('invalid')
    );
  } else {
    statusText.textContent = 'No PIN is set. The app is accessible to anyone on the network.';
    setForm.style.display = 'block';
    changeForm.style.display = 'none';
    setForm.reset();
    ['newPinSet', 'confirmPinSet'].forEach((id) =>
      document.getElementById(id).classList.remove('invalid')
    );
  }
}

async function submitSetPin(e) {
  e.preventDefault();
  const newPin = document.getElementById('newPinSet').value;
  const confirmPin = document.getElementById('confirmPinSet').value;

  if (newPin !== confirmPin) {
    document.getElementById('confirmPinSet').classList.add('invalid');
    showToast('PINs do not match', 'error');
    return;
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    document.getElementById('newPinSet').classList.add('invalid');
    showToast('PIN must be 4-8 digits', 'error');
    return;
  }

  const res = await apiFetch('/api/auth/pin', {
    method: 'POST',
    body: JSON.stringify({ newPin }),
  });
  if (!res) return;

  const data = await res.json();
  if (res.ok) {
    pinEnabled = true;
    document.getElementById('lockBtn').style.display = '';
    refreshSettingsUI();
    showToast('PIN enabled', 'success');
  } else {
    showToast(data.error || 'Failed to set PIN', 'error');
  }
}

async function submitChangePin(e) {
  e.preventDefault();
  const currentPin = document.getElementById('currentPin').value;
  const newPin = document.getElementById('newPinChange').value;
  const confirmPin = document.getElementById('confirmPinChange').value;

  if (newPin !== confirmPin) {
    document.getElementById('confirmPinChange').classList.add('invalid');
    showToast('New PINs do not match', 'error');
    return;
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    document.getElementById('newPinChange').classList.add('invalid');
    showToast('PIN must be 4-8 digits', 'error');
    return;
  }

  const res = await apiFetch('/api/auth/pin', {
    method: 'POST',
    body: JSON.stringify({ newPin, currentPin }),
  });
  if (!res) return;

  const data = await res.json();
  if (res.ok) {
    refreshSettingsUI();
    showToast('PIN updated', 'success');
  } else {
    document.getElementById('currentPin').classList.add('invalid');
    showToast(data.error || 'Failed to update PIN', 'error');
  }
}

async function removePin() {
  const currentPin = document.getElementById('currentPin').value;
  if (!currentPin) {
    document.getElementById('currentPin').classList.add('invalid');
    showToast('Enter your current PIN first', 'error');
    return;
  }

  const res = await apiFetch('/api/auth/pin', {
    method: 'POST',
    body: JSON.stringify({ currentPin }),
  });
  if (!res) return;

  const data = await res.json();
  if (res.ok) {
    pinEnabled = false;
    document.getElementById('lockBtn').style.display = 'none';
    refreshSettingsUI();
    showToast('PIN removed', 'success');
  } else {
    document.getElementById('currentPin').classList.add('invalid');
    showToast(data.error || 'Failed to remove PIN', 'error');
  }
}

function openOverlay(id) {
  const el = document.getElementById(id);
  el.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
}

function closeOverlay(id) {
  const el = document.getElementById(id);
  el.classList.remove('open');
  setTimeout(() => { el.style.display = 'none'; }, 300);
}

function bindEvents() {
  document.getElementById('addDeviceBtn').addEventListener('click', () => openDeviceModal());
  document.getElementById('emptyAddBtn').addEventListener('click', () => openDeviceModal());
  document.getElementById('deviceForm').addEventListener('submit', submitDevice);
  document.getElementById('closeModal').addEventListener('click', closeDeviceModal);
  document.getElementById('cancelBtn').addEventListener('click', closeDeviceModal);
  document.getElementById('deviceMAC').addEventListener('input', (e) => e.target.classList.remove('invalid'));

  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', () => closeOverlay('settingsModal'));
  document.getElementById('settingsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeOverlay('settingsModal'); });
  document.getElementById('setPinForm').addEventListener('submit', submitSetPin);
  document.getElementById('changePinForm').addEventListener('submit', submitChangePin);
  document.getElementById('removePinBtn').addEventListener('click', removePin);
  ['currentPin', 'newPinChange', 'confirmPinChange', 'newPinSet', 'confirmPinSet'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (e) => e.target.classList.remove('invalid'));
  });

  document.getElementById('lockBtn').addEventListener('click', lockApp);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  document.getElementById('deviceGrid').addEventListener('click', (e) => {
    const powerBtn = e.target.closest('.power-btn');
    const editBtn = e.target.closest('.btn-edit');
    const deleteBtn = e.target.closest('.btn-delete');
    if (powerBtn) wakeDevice(powerBtn.dataset.id);
    else if (editBtn) openDeviceModal(devices.find((d) => d.id === editBtn.dataset.id));
    else if (deleteBtn) confirmDelete(deleteBtn.dataset.id);
  });

  document.getElementById('numpad').addEventListener('click', (e) => {
    const key = e.target.closest('.numpad-key');
    if (!key) return;
    if (key.id === 'pinBackspace') deletePinDigit();
    else if (key.dataset.digit !== undefined) appendPinDigit(key.dataset.digit);
  });

  document.addEventListener('keydown', (e) => {
    if (document.getElementById('pinScreen').style.display !== 'none') {
      if (/^\d$/.test(e.key)) appendPinDigit(e.key);
      else if (e.key === 'Backspace') deletePinDigit();
      return;
    }
    if (e.key === 'Escape') {
      closeDeviceModal();
      closeOverlay('settingsModal');
      closeOverlay('confirmOverlay');
    }
  });
}

function getSavedTheme() { return localStorage.getItem('theme') || 'dark'; }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeColorMeta').setAttribute('content', theme === 'dark' ? '#0a0b0f' : '#f0f2f7');
  document.getElementById('sunIcon').style.display = theme === 'dark' ? '' : 'none';
  document.getElementById('moonIcon').style.display = theme === 'dark' ? 'none' : '';
}

function toggleTheme() {
  const next = getSavedTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

function saveLastWake(id) {
  const w = JSON.parse(localStorage.getItem('lastWake') || '{}');
  w[id] = Date.now();
  localStorage.setItem('lastWake', JSON.stringify(w));
}

function getLastWake(id) {
  return JSON.parse(localStorage.getItem('lastWake') || '{}')[id] || null;
}

function updateLastWakeDisplay(id) {
  const card = document.querySelector(`.device-card[data-id="${id}"]`);
  if (!card) return;
  let p = card.querySelector('.device-last-wake');
  if (!p) { p = document.createElement('p'); p.className = 'device-last-wake'; card.querySelector('.device-meta').appendChild(p); }
  p.textContent = `Last woken ${relativeTime(getLastWake(id))}`;
}

function relativeTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  toast.innerHTML = `${icon}<span>${esc(message)}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3200);
}

function esc(str) { const d = document.createElement('div'); d.textContent = String(str ?? ''); return d.innerHTML; }

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js'); }
  catch (err) { console.warn('SW registration failed:', err); }
}

init();
