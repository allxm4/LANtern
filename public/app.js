'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let devices = [];
let vms = [];
let nodes = [];
let vmStatuses = {};      // { [vmId]: { status, uptime } }
let editingId = null;     // device being edited
let editingVMId = null;   // VM being edited
let activeTab = 'devices';
let sessionToken = null;
let pinEnabled = false;

const TOKEN_KEY = 'LANtern_token';
const TOKEN_EXP_KEY = 'LANtern_token_exp';
const SESSION_CLIENT_HOURS = 8;

// ─── Token Storage ────────────────────────────────────────────────────────────

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

// ─── API Fetch ────────────────────────────────────────────────────────────────

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

// ─── Init ─────────────────────────────────────────────────────────────────────

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
  await Promise.all([fetchDevices(), fetchNodes(), fetchVMs()]);
  updateAllTab();
}

// ─── PIN Screen ───────────────────────────────────────────────────────────────

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
    await Promise.all([fetchDevices(), fetchNodes(), fetchVMs()]);
    updateAllTab();
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

// ─── Tab Navigation ───────────────────────────────────────────────────────────

function switchTab(tab) {
  activeTab = tab;
  const isDevices = tab === 'devices';
  const isVMs = tab === 'vms';
  const isAll = tab === 'all';

  document.getElementById('panelDevices').style.display = isDevices ? '' : 'none';
  document.getElementById('panelVMs').style.display = isVMs ? '' : 'none';
  document.getElementById('panelAll').style.display = isAll ? '' : 'none';
  document.getElementById('tabDevices').classList.toggle('active', isDevices);
  document.getElementById('tabVMs').classList.toggle('active', isVMs);
  document.getElementById('tabAll').classList.toggle('active', isAll);
  document.getElementById('tabDevices').setAttribute('aria-selected', String(isDevices));
  document.getElementById('tabVMs').setAttribute('aria-selected', String(isVMs));
  document.getElementById('tabAll').setAttribute('aria-selected', String(isAll));
  document.getElementById('addDeviceBtn').style.display = isDevices ? '' : 'none';
  document.getElementById('addNodeHeaderBtn').style.display = isVMs ? '' : 'none';
  document.getElementById('addVMBtn').style.display = isVMs ? '' : 'none';

  if (isVMs || isAll) fetchVMsWithStatus();
  if (isAll) renderAll();
}

// ─── Devices ──────────────────────────────────────────────────────────────────

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
    updateAllTab();
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';
  grid.innerHTML = devices.map(deviceCard).join('');
  updateAllTab();
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

// ─── Virtual Machines ─────────────────────────────────────────────────────────

async function fetchNodes() {
  const res = await apiFetch('/api/proxmox/nodes');
  if (!res || !res.ok) return;
  nodes = await res.json();
}

async function fetchVMs() {
  const res = await apiFetch('/api/proxmox/vms');
  if (!res || !res.ok) return;
  vms = await res.json();
}

async function fetchVMsWithStatus() {
  await fetchVMs();
  renderVMs();
  if (activeTab === 'all') renderAll();

  if (!vms.length) return;

  // Fetch all statuses concurrently; each updates its badge as it resolves
  await Promise.allSettled(vms.map(async (vm) => {
    const res = await apiFetch(`/api/proxmox/vms/${vm.id}/status`);
    if (!res || !res.ok) {
      updateVMStatusBadge(vm.id, { status: 'unknown', uptime: 0 });
      return;
    }
    const data = await res.json();
    vmStatuses[vm.id] = data;
    updateVMStatusBadge(vm.id, data);
  }));
}

function renderVMs() {
  const grid = document.getElementById('vmGrid');
  const empty = document.getElementById('vmEmptyState');
  const noNodes = document.getElementById('vmNoNodesState');

  if (!nodes.length) {
    grid.style.display = 'none';
    empty.style.display = 'none';
    noNodes.style.display = '';
    updateAllTab();
    return;
  }

  if (!vms.length) {
    grid.style.display = 'none';
    empty.style.display = '';
    noNodes.style.display = 'none';
    updateAllTab();
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';
  noNodes.style.display = 'none';
  grid.innerHTML = vms.map(vmCard).join('');
  updateAllTab();
}

function updateAllTab() {
  const show = devices.length > 0 && vms.length > 0;
  document.getElementById('tabAll').style.display = show ? '' : 'none';
  if (!show && activeTab === 'all') switchTab('devices');
}

function renderAll() {
  const grid = document.getElementById('allGrid');
  let html = '';
  if (devices.length) {
    html += `<div class="all-section-label">Devices</div><div class="device-grid">${devices.map(deviceCard).join('')}</div>`;
  }
  if (vms.length) {
    html += `<div class="all-section-label">Virtual Machines</div><div class="device-grid">${vms.map(vmCard).join('')}</div>`;
  }
  grid.innerHTML = html;
}

function vmCard(vm) {
  const s = vmStatuses[vm.id];
  const statusClass = !s ? 'status-loading' : s.status === 'running' ? 'status-running' : s.status === 'stopped' ? 'status-stopped' : 'status-unknown';
  const statusLabel = s ? s.status : '…';
  const uptimeHtml = s?.status === 'running' && s.uptime
    ? `<p class="device-last-wake">Up ${formatUptime(s.uptime)}</p>` : '';

  return `
    <article class="device-card" data-vm-id="${vm.id}">
      <div class="device-meta">
        <div class="vm-title-row">
          <h3 class="device-name">${esc(vm.name)}</h3>
          <span class="status-badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="device-detail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="2" y="2" width="20" height="8" rx="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
          <span>VMID ${esc(vm.vmid)} · ${esc(vm.nodeName)}</span>
        </div>
        ${uptimeHtml}
      </div>
      <div class="card-bottom">
        <div class="card-actions">
          <button class="btn-icon btn-edit" data-vm-id="${vm.id}" title="Edit ${esc(vm.name)}" aria-label="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn-icon btn-delete" data-vm-id="${vm.id}" title="Remove ${esc(vm.name)}" aria-label="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>
        <div class="vm-action-btns">
          <button class="vm-action-btn vm-start-btn" data-vm-id="${vm.id}" title="Start ${esc(vm.name)}" aria-label="Start">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </button>
          <button class="vm-action-btn vm-stop-btn" data-vm-id="${vm.id}" title="Shutdown ${esc(vm.name)}" aria-label="Shutdown">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
        </div>
      </div>
    </article>`;
}

function updateVMStatusBadge(vmId, statusData) {
  document.querySelectorAll(`[data-vm-id="${vmId}"]`).forEach((card) => {
    const badge = card.querySelector('.status-badge');
    if (badge) {
      badge.className = `status-badge status-${statusData.status === 'running' ? 'running' : statusData.status === 'stopped' ? 'stopped' : 'unknown'}`;
      badge.textContent = statusData.status;
    }

    const meta = card.querySelector('.device-meta');
    let uptimeEl = card.querySelector('.device-last-wake');
    if (statusData.status === 'running' && statusData.uptime) {
      if (!uptimeEl) {
        uptimeEl = document.createElement('p');
        uptimeEl.className = 'device-last-wake';
        meta.appendChild(uptimeEl);
      }
      uptimeEl.textContent = `Up ${formatUptime(statusData.uptime)}`;
    } else if (uptimeEl) {
      uptimeEl.remove();
    }
  });
}

async function startVM(id) {
  const vm = vms.find((v) => v.id === id);
  if (!vm) return;
  const btn = document.querySelector(`.vm-start-btn[data-vm-id="${id}"]`);
  if (!btn || btn.classList.contains('sending')) return;

  btn.classList.add('sending');
  const res = await apiFetch(`/api/proxmox/vms/${id}/start`, { method: 'POST' });
  btn.classList.remove('sending');

  if (!res) return;
  const data = await res.json();

  if (res.ok) {
    vmStatuses[id] = { status: 'running', uptime: 0 };
    updateVMStatusBadge(id, vmStatuses[id]);
    showToast(data.message || `${vm.name} is starting`, 'success');
  } else {
    showToast(data.error || 'Failed to start VM', 'error');
  }
}

async function stopVM(id) {
  const vm = vms.find((v) => v.id === id);
  if (!vm) return;
  const btn = document.querySelector(`.vm-stop-btn[data-vm-id="${id}"]`);
  if (!btn || btn.classList.contains('sending')) return;

  btn.classList.add('sending');
  const res = await apiFetch(`/api/proxmox/vms/${id}/stop`, { method: 'POST' });
  btn.classList.remove('sending');

  if (!res) return;
  const data = await res.json();

  if (res.ok) {
    vmStatuses[id] = { status: 'stopped', uptime: 0 };
    updateVMStatusBadge(id, vmStatuses[id]);
    showToast(data.message || `${vm.name} is shutting down`, 'success');
  } else {
    showToast(data.error || 'Failed to shutdown VM', 'error');
  }
}

function openVMModal(vm = null) {
  if (!nodes.length) {
    showToast('Add a Proxmox node in Settings first', 'error');
    return;
  }

  editingVMId = vm?.id || null;
  document.getElementById('vmModalTitle').textContent = vm ? 'Edit Virtual Machine' : 'Add Virtual Machine';
  document.getElementById('saveVMBtn').textContent = vm ? 'Update VM' : 'Save VM';
  document.getElementById('vmName').value = vm?.name || '';
  document.getElementById('vmVmid').value = vm?.vmid || '';

  const sel = document.getElementById('vmNode');
  sel.innerHTML = nodes.map((n) =>
    `<option value="${n.id}" ${vm?.nodeId === n.id ? 'selected' : ''}>${esc(n.name)} (${esc(n.host)})</option>`
  ).join('');

  ['vmName', 'vmVmid'].forEach((id) => document.getElementById(id).classList.remove('invalid'));

  openOverlay('vmModal');
  setTimeout(() => document.getElementById('vmName').focus(), 50);
}

function closeVMModal() {
  closeOverlay('vmModal');
  setTimeout(() => { document.getElementById('vmForm').reset(); editingVMId = null; }, 300);
}

async function submitVM(e) {
  e.preventDefault();
  const name = document.getElementById('vmName').value.trim();
  const vmid = document.getElementById('vmVmid').value.trim();
  const nodeId = document.getElementById('vmNode').value;

  if (!name) { document.getElementById('vmName').classList.add('invalid'); return; }
  if (!vmid || !/^\d+$/.test(vmid)) { document.getElementById('vmVmid').classList.add('invalid'); return; }

  const saveBtn = document.getElementById('saveVMBtn');
  saveBtn.disabled = true;

  const res = await apiFetch(
    editingVMId ? `/api/proxmox/vms/${editingVMId}` : '/api/proxmox/vms',
    { method: editingVMId ? 'PUT' : 'POST', body: JSON.stringify({ name, vmid, nodeId }) }
  );

  saveBtn.disabled = false;
  if (!res) return;

  const data = await res.json();
  if (res.ok) {
    closeVMModal();
    await fetchVMsWithStatus();
    showToast(editingVMId ? 'VM updated' : 'VM added', 'success');
  } else {
    showToast(data.error || 'Failed to save VM', 'error');
  }
}

function confirmDeleteVM(id) {
  const vm = vms.find((v) => v.id === id);
  if (!vm) return;
  document.getElementById('confirmMessage').textContent = `"${vm.name}" will be removed from LANtern. The VM itself will not be affected in Proxmox.`;

  openOverlay('confirmOverlay');
  document.getElementById('confirmOk').onclick = async () => { closeOverlay('confirmOverlay'); await deleteVM(id); };
  document.getElementById('confirmCancel').onclick = () => closeOverlay('confirmOverlay');
}

async function deleteVM(id) {
  const res = await apiFetch(`/api/proxmox/vms/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (res.ok) {
    delete vmStatuses[id];
    await fetchVMsWithStatus();
    showToast('VM removed', 'success');
  } else {
    showToast('Failed to remove VM', 'error');
  }
}

// ─── Proxmox Node Management (in Settings) ────────────────────────────────────

function renderNodeList() {
  const list = document.getElementById('nodeList');
  if (!nodes.length) {
    list.innerHTML = '<p class="settings-desc" style="margin-top:8px">No nodes configured yet.</p>';
    return;
  }
  list.innerHTML = nodes.map((n) => `
    <div class="node-row">
      <div class="node-row-info">
        <span class="node-row-name">${esc(n.name)}</span>
        <span class="node-row-host">${esc(n.host)}</span>
      </div>
      <button class="btn-icon btn-delete" data-node-id="${n.id}" title="Remove ${esc(n.name)}" aria-label="Remove node">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>`).join('');
}

function openNodeModal() {
  document.getElementById('nodeForm').reset();
  ['nodeName', 'nodeHost', 'nodeUser', 'nodeTokenName', 'nodeTokenValue'].forEach((id) =>
    document.getElementById(id).classList.remove('invalid')
  );
  openOverlay('nodeModal');
  setTimeout(() => document.getElementById('nodeName').focus(), 50);
}

function closeNodeModal() {
  closeOverlay('nodeModal');
  setTimeout(() => document.getElementById('nodeForm').reset(), 300);
}

async function submitNode(e) {
  e.preventDefault();
  const name = document.getElementById('nodeName').value.trim();
  const host = document.getElementById('nodeHost').value.trim();
  const user = document.getElementById('nodeUser').value.trim();
  const tokenName = document.getElementById('nodeTokenName').value.trim();
  const tokenValue = document.getElementById('nodeTokenValue').value.trim();

  const saveBtn = document.getElementById('saveNodeBtn');
  saveBtn.disabled = true;

  const res = await apiFetch('/api/proxmox/nodes', {
    method: 'POST',
    body: JSON.stringify({ name, host, user, tokenName, tokenValue }),
  });

  saveBtn.disabled = false;
  if (!res) return;

  const data = await res.json();
  if (res.ok) {
    closeNodeModal();
    await fetchNodes();
    renderNodeList();
    renderVMs();
    showToast(`Node "${name}" added`, 'success');
  } else {
    showToast(data.error || 'Failed to add node', 'error');
  }
}

function confirmDeleteNode(id) {
  const node = nodes.find((n) => n.id === id);
  if (!node) return;
  const vmCount = vms.filter((v) => v.nodeId === id).length;
  const vmNote = vmCount ? ` This will also remove ${vmCount} VM${vmCount !== 1 ? 's' : ''} on this node.` : '';
  document.getElementById('confirmMessage').textContent = `Remove node "${node.name}"?${vmNote}`;

  openOverlay('confirmOverlay');
  document.getElementById('confirmOk').onclick = async () => { closeOverlay('confirmOverlay'); await deleteNode(id); };
  document.getElementById('confirmCancel').onclick = () => closeOverlay('confirmOverlay');
}

async function deleteNode(id) {
  const res = await apiFetch(`/api/proxmox/nodes/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (res.ok) {
    await fetchNodes();
    await fetchVMs();
    renderNodeList();
    if (activeTab === 'vms') renderVMs();
    showToast('Node removed', 'success');
  } else {
    showToast('Failed to remove node', 'error');
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function openSettings() {
  refreshSettingsUI();
  renderNodeList();
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

// ─── Overlay Helpers ──────────────────────────────────────────────────────────

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

// ─── Event Binding ────────────────────────────────────────────────────────────

function bindEvents() {
  // Tabs
  document.getElementById('tabDevices').addEventListener('click', () => switchTab('devices'));
  document.getElementById('tabVMs').addEventListener('click', () => switchTab('vms'));
  document.getElementById('tabAll').addEventListener('click', () => switchTab('all'));

  // Devices
  document.getElementById('addDeviceBtn').addEventListener('click', () => openDeviceModal());
  document.getElementById('emptyAddBtn').addEventListener('click', () => openDeviceModal());
  document.getElementById('deviceForm').addEventListener('submit', submitDevice);
  document.getElementById('closeModal').addEventListener('click', closeDeviceModal);
  document.getElementById('cancelBtn').addEventListener('click', closeDeviceModal);
  document.getElementById('deviceMAC').addEventListener('input', (e) => e.target.classList.remove('invalid'));

  document.getElementById('deviceGrid').addEventListener('click', (e) => {
    const powerBtn = e.target.closest('.power-btn');
    const editBtn = e.target.closest('.btn-edit');
    const deleteBtn = e.target.closest('.btn-delete');
    if (powerBtn) wakeDevice(powerBtn.dataset.id);
    else if (editBtn) openDeviceModal(devices.find((d) => d.id === editBtn.dataset.id));
    else if (deleteBtn) confirmDelete(deleteBtn.dataset.id);
  });

  // VMs
  document.getElementById('addNodeHeaderBtn').addEventListener('click', openNodeModal);
  document.getElementById('addVMBtn').addEventListener('click', () => openVMModal());
  document.getElementById('vmEmptyAddBtn').addEventListener('click', () => openVMModal());
  document.getElementById('vmGoToSettingsBtn').addEventListener('click', openNodeModal);
  document.getElementById('vmForm').addEventListener('submit', submitVM);
  document.getElementById('closeVMModal').addEventListener('click', closeVMModal);
  document.getElementById('cancelVMBtn').addEventListener('click', closeVMModal);
  ['vmName', 'vmVmid'].forEach((id) =>
    document.getElementById(id).addEventListener('input', (e) => e.target.classList.remove('invalid'))
  );

  document.getElementById('vmGrid').addEventListener('click', (e) => {
    const startBtn = e.target.closest('.vm-start-btn');
    const stopBtn = e.target.closest('.vm-stop-btn');
    const editBtn = e.target.closest('.btn-edit[data-vm-id]');
    const deleteBtn = e.target.closest('.btn-delete[data-vm-id]');
    if (startBtn) startVM(startBtn.dataset.vmId);
    else if (stopBtn) stopVM(stopBtn.dataset.vmId);
    else if (editBtn) openVMModal(vms.find((v) => v.id === editBtn.dataset.vmId));
    else if (deleteBtn) confirmDeleteVM(deleteBtn.dataset.vmId);
  });

  document.getElementById('allGrid').addEventListener('click', (e) => {
    const startBtn = e.target.closest('.vm-start-btn');
    const stopBtn = e.target.closest('.vm-stop-btn');
    const vmEditBtn = e.target.closest('.btn-edit[data-vm-id]');
    const vmDeleteBtn = e.target.closest('.btn-delete[data-vm-id]');
    const powerBtn = e.target.closest('.power-btn');
    const deviceEditBtn = e.target.closest('.btn-edit[data-id]');
    const deviceDeleteBtn = e.target.closest('.btn-delete[data-id]');
    if (startBtn) startVM(startBtn.dataset.vmId);
    else if (stopBtn) stopVM(stopBtn.dataset.vmId);
    else if (vmEditBtn) openVMModal(vms.find((v) => v.id === vmEditBtn.dataset.vmId));
    else if (vmDeleteBtn) confirmDeleteVM(vmDeleteBtn.dataset.vmId);
    else if (powerBtn) wakeDevice(powerBtn.dataset.id);
    else if (deviceEditBtn) openDeviceModal(devices.find((d) => d.id === deviceEditBtn.dataset.id));
    else if (deviceDeleteBtn) confirmDelete(deviceDeleteBtn.dataset.id);
  });

  // Settings
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', () => closeOverlay('settingsModal'));
  document.getElementById('settingsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeOverlay('settingsModal'); });
  document.getElementById('setPinForm').addEventListener('submit', submitSetPin);
  document.getElementById('changePinForm').addEventListener('submit', submitChangePin);
  document.getElementById('removePinBtn').addEventListener('click', removePin);
  ['currentPin', 'newPinChange', 'confirmPinChange', 'newPinSet', 'confirmPinSet'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (e) => e.target.classList.remove('invalid'));
  });

  // Nodes (within settings)
  document.getElementById('addNodeBtn').addEventListener('click', openNodeModal);
  document.getElementById('closeNodeModal').addEventListener('click', closeNodeModal);
  document.getElementById('cancelNodeBtn').addEventListener('click', closeNodeModal);
  document.getElementById('nodeForm').addEventListener('submit', submitNode);
  document.getElementById('nodeList').addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.btn-delete[data-node-id]');
    if (deleteBtn) confirmDeleteNode(deleteBtn.dataset.nodeId);
  });

  // Lock / Theme
  document.getElementById('lockBtn').addEventListener('click', lockApp);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // Numpad
  document.getElementById('numpad').addEventListener('click', (e) => {
    const key = e.target.closest('.numpad-key');
    if (!key) return;
    if (key.id === 'pinBackspace') deletePinDigit();
    else if (key.dataset.digit !== undefined) appendPinDigit(key.dataset.digit);
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('pinScreen').style.display !== 'none') {
      if (/^\d$/.test(e.key)) appendPinDigit(e.key);
      else if (e.key === 'Backspace') deletePinDigit();
      return;
    }
    if (e.key === 'Escape') {
      closeDeviceModal();
      closeVMModal();
      closeNodeModal();
      closeOverlay('settingsModal');
      closeOverlay('confirmOverlay');
    }
  });
}

// ─── Theme ────────────────────────────────────────────────────────────────────

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

// ─── Wake Tracking ────────────────────────────────────────────────────────────

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

// ─── Time Helpers ─────────────────────────────────────────────────────────────

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

function formatUptime(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

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

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(str) { const d = document.createElement('div'); d.textContent = String(str ?? ''); return d.innerHTML; }

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js'); }
  catch (err) { console.warn('SW registration failed:', err); }
}

init();
