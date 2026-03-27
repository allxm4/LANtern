require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DEVICES_FILE = process.env.DEVICES_FILE || '/config/devices.json';
const CONFIG_FILE = process.env.CONFIG_FILE || '/config/config.json';
const PROXMOX_FILE = process.env.PROXMOX_FILE || '/config/proxmox.json';
const SESSION_TTL = (parseInt(process.env.SESSION_TTL_HOURS) || 8) * 60 * 60 * 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config / Devices ────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ pinHash: null }, null, 2));
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { pinHash: null };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadDevices() {
  try {
    if (!fs.existsSync(DEVICES_FILE)) {
      const dir = path.dirname(DEVICES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DEVICES_FILE, '[]');
    }
    return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveDevices(devices) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
}

// ─── Proxmox Config ───────────────────────────────────────────────────────────

function loadProxmox() {
  try {
    if (!fs.existsSync(PROXMOX_FILE)) {
      const dir = path.dirname(PROXMOX_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PROXMOX_FILE, JSON.stringify({ nodes: [], vms: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(PROXMOX_FILE, 'utf8'));
  } catch {
    return { nodes: [], vms: [] };
  }
}

function saveProxmox(data) {
  fs.writeFileSync(PROXMOX_FILE, JSON.stringify(data, null, 2));
}

// ─── Proxmox HTTP Helper ──────────────────────────────────────────────────────
// Uses a per-request agent with rejectUnauthorized:false to support
// Proxmox's self-signed certificates without disabling TLS globally.

function proxmoxRequest(node, method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const [hostname, portStr] = node.host.split(':');
    const port = parseInt(portStr) || 8006;
    const authHeader = `PVEAPIToken=${node.user}!${node.tokenName}=${node.tokenValue}`;
    const payload = body ? JSON.stringify(body) : null;

    const agent = new https.Agent({ rejectUnauthorized: false });

    const options = {
      agent,
      hostname,
      port,
      path: `/api2/json${endpoint}`,
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        'Content-Length': payload ? Buffer.byteLength(payload) : 0,
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed?.errors
              ? Object.values(parsed.errors).join(', ')
              : parsed?.message || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
          }
        } catch {
          reject(new Error(`HTTP ${res.statusCode}: unparseable response`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

function isValidIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((n) => parseInt(n) <= 255);
}

function normalizeMAC(mac) {
  const clean = mac.replace(/[^0-9A-Fa-f]/g, '');
  if (clean.length !== 12) throw new Error('Invalid MAC address');
  return clean.toUpperCase().match(/.{2}/g).join(':');
}

// ─── Wake on LAN ──────────────────────────────────────────────────────────────

function sendMagicPacket(mac, broadcastAddress = '255.255.255.255', port = 9) {
  return new Promise((resolve, reject) => {
    const macClean = mac.replace(/[:-]/g, '');
    const buffer = Buffer.alloc(102);
    for (let i = 0; i < 6; i++) buffer[i] = 0xff;
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 6; j++) {
        buffer[6 + i * 6 + j] = parseInt(macClean.slice(j * 2, j * 2 + 2), 16);
      }
    }
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => { socket.close(); reject(err); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(buffer, 0, buffer.length, port, broadcastAddress, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// ─── Auth ────────────────────────────────────────────────────────────────────

const sessions = new Map();

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  if (sessions.size > 1000) {
    const now = Date.now();
    for (const [k, exp] of sessions) if (now > exp) sessions.delete(k);
  }
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function deleteSession(token) {
  sessions.delete(token);
}

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const e = loginAttempts.get(ip);
  if (!e) return { allowed: true };
  if (e.lockedUntil && Date.now() < e.lockedUntil) {
    return { allowed: false, remaining: Math.ceil((e.lockedUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}

function recordFail(ip) {
  const e = loginAttempts.get(ip) || { count: 0 };
  e.count++;
  if (e.count >= MAX_ATTEMPTS) {
    e.lockedUntil = Date.now() + LOCK_MS;
    e.count = 0;
  }
  loginAttempts.set(ip, e);
}

function clearFails(ip) {
  loginAttempts.delete(ip);
}

function requireAuth(req, res, next) {
  const config = loadConfig();
  if (!config.pinHash) return next();
  const token = req.headers['x-session-token'];
  if (isValidSession(token)) return next();
  res.status(401).json({ error: 'Unauthorized', requiresPin: true });
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.get('/api/auth/status', (req, res) => {
  const config = loadConfig();
  const token = req.headers['x-session-token'];
  res.json({
    pinEnabled: !!config.pinHash,
    authenticated: !config.pinHash || isValidSession(token),
  });
});

app.post('/api/auth/login', (req, res) => {
  const ip = getIP(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${rl.remaining}s.` });
  }

  const config = loadConfig();
  if (!config.pinHash) {
    return res.json({ token: createSession() });
  }

  const { pin } = req.body;
  if (!pin || hashPin(pin) !== config.pinHash) {
    recordFail(ip);
    const after = checkRateLimit(ip);
    return res.status(401).json({
      error: 'Incorrect PIN',
      attemptsLeft: after.allowed ? Math.max(0, MAX_ATTEMPTS - (loginAttempts.get(ip)?.count || 0)) : 0,
      locked: !after.allowed,
    });
  }

  clearFails(ip);
  res.json({ token: createSession() });
});

app.post('/api/auth/logout', (req, res) => {
  deleteSession(req.headers['x-session-token']);
  res.json({ success: true });
});

app.post('/api/auth/pin', requireAuth, (req, res) => {
  const { newPin, currentPin } = req.body;
  const config = loadConfig();

  if (config.pinHash) {
    if (!currentPin || hashPin(String(currentPin)) !== config.pinHash) {
      return res.status(401).json({ error: 'Current PIN is incorrect' });
    }
  }

  if (!newPin) {
    config.pinHash = null;
    saveConfig(config);
    return res.json({ success: true, pinEnabled: false });
  }

  const pinStr = String(newPin);
  if (!/^\d{4,8}$/.test(pinStr)) {
    return res.status(400).json({ error: 'PIN must be 4-8 digits' });
  }

  config.pinHash = hashPin(pinStr);
  saveConfig(config);
  res.json({ success: true, pinEnabled: true });
});

// ─── Device Routes ────────────────────────────────────────────────────────────

app.get('/api/devices', requireAuth, (req, res) => {
  res.json(loadDevices());
});

app.post('/api/devices', requireAuth, (req, res) => {
  const { name, mac, ip, broadcastAddress } = req.body;
  if (!name?.trim() || !mac) {
    return res.status(400).json({ error: 'Name and MAC address are required' });
  }
  if (name.trim().length > 64) {
    return res.status(400).json({ error: 'Name must be 64 characters or fewer' });
  }
  let normalizedMAC;
  try { normalizedMAC = normalizeMAC(mac); }
  catch { return res.status(400).json({ error: 'Invalid MAC address format' }); }

  const trimmedIP = ip?.trim() || '';
  if (trimmedIP && !isValidIPv4(trimmedIP)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }
  const trimmedBroadcast = broadcastAddress?.trim() || '255.255.255.255';
  if (!isValidIPv4(trimmedBroadcast)) {
    return res.status(400).json({ error: 'Invalid broadcast address' });
  }

  const devices = loadDevices();
  const device = {
    id: crypto.randomUUID(),
    name: name.trim(),
    mac: normalizedMAC,
    ip: trimmedIP,
    broadcastAddress: trimmedBroadcast,
    createdAt: new Date().toISOString(),
  };
  devices.push(device);
  saveDevices(devices);
  res.status(201).json(device);
});

app.put('/api/devices/:id', requireAuth, (req, res) => {
  const { name, mac, ip, broadcastAddress } = req.body;
  const devices = loadDevices();
  const idx = devices.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Device not found' });
  if (!name?.trim() || !mac) {
    return res.status(400).json({ error: 'Name and MAC address are required' });
  }
  if (name.trim().length > 64) {
    return res.status(400).json({ error: 'Name must be 64 characters or fewer' });
  }
  let normalizedMAC;
  try { normalizedMAC = normalizeMAC(mac); }
  catch { return res.status(400).json({ error: 'Invalid MAC address format' }); }

  const trimmedIP = ip?.trim() || '';
  if (trimmedIP && !isValidIPv4(trimmedIP)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }
  const trimmedBroadcast = broadcastAddress?.trim() || '255.255.255.255';
  if (!isValidIPv4(trimmedBroadcast)) {
    return res.status(400).json({ error: 'Invalid broadcast address' });
  }

  devices[idx] = {
    ...devices[idx],
    name: name.trim(),
    mac: normalizedMAC,
    ip: trimmedIP,
    broadcastAddress: trimmedBroadcast,
    updatedAt: new Date().toISOString(),
  };
  saveDevices(devices);
  res.json(devices[idx]);
});

app.delete('/api/devices/:id', requireAuth, (req, res) => {
  const devices = loadDevices();
  const filtered = devices.filter((d) => d.id !== req.params.id);
  if (filtered.length === devices.length) {
    return res.status(404).json({ error: 'Device not found' });
  }
  saveDevices(filtered);
  res.json({ success: true });
});

// ─── Wake Routes ──────────────────────────────────────────────────────────────

app.post('/api/wake/:id', requireAuth, async (req, res) => {
  const devices = loadDevices();
  const device = devices.find((d) => d.id === req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  try {
    await sendMagicPacket(device.mac, device.broadcastAddress || '255.255.255.255');
    res.json({ success: true, message: `Magic packet sent to ${device.name}` });
  } catch (err) {
    res.status(500).json({ error: `Failed to send packet: ${err.message}` });
  }
});

app.post('/api/wake/mac/:mac', requireAuth, async (req, res) => {
  const { broadcastAddress = '255.255.255.255' } = req.body || {};
  if (!isValidIPv4(broadcastAddress)) {
    return res.status(400).json({ error: 'Invalid broadcast address' });
  }
  let normalizedMAC;
  try { normalizedMAC = normalizeMAC(req.params.mac); }
  catch { return res.status(400).json({ error: 'Invalid MAC address' }); }
  try {
    await sendMagicPacket(normalizedMAC, broadcastAddress);
    res.json({ success: true, message: `Magic packet sent to ${normalizedMAC}` });
  } catch (err) {
    res.status(500).json({ error: `Failed to send packet: ${err.message}` });
  }
});

// ─── Proxmox Node Routes ──────────────────────────────────────────────────────

app.get('/api/proxmox/nodes', requireAuth, (_req, res) => {
  const { nodes } = loadProxmox();
  // Never expose token credentials in responses
  res.json(nodes.map(({ id, name, host, user, tokenName }) => ({ id, name, host, user, tokenName })));
});

app.post('/api/proxmox/nodes', requireAuth, (req, res) => {
  const { name, host, user, tokenName, tokenValue } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Node name is required' });
  if (name.trim().length > 64) return res.status(400).json({ error: 'Node name must be 64 characters or fewer' });
  if (/[/\\]/.test(name.trim())) return res.status(400).json({ error: 'Node name must not contain slashes' });
  if (!host?.trim()) return res.status(400).json({ error: 'Host is required' });
  if (!user?.trim()) return res.status(400).json({ error: 'API user is required' });
  if (!tokenName?.trim()) return res.status(400).json({ error: 'Token name is required' });
  if (!tokenValue?.trim()) return res.status(400).json({ error: 'Token value is required' });

  const data = loadProxmox();
  if (data.nodes.some((n) => n.name === name.trim())) {
    return res.status(409).json({ error: `Node "${name.trim()}" already exists` });
  }

  const node = {
    id: crypto.randomUUID(),
    name: name.trim(),
    host: host.trim(),
    user: user.trim(),
    tokenName: tokenName.trim(),
    tokenValue: tokenValue.trim(),
  };
  data.nodes.push(node);
  saveProxmox(data);

  const { tokenValue: _tv, ...safe } = node;
  res.status(201).json(safe);
});

app.delete('/api/proxmox/nodes/:id', requireAuth, (req, res) => {
  const data = loadProxmox();
  const idx = data.nodes.findIndex((n) => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Node not found' });

  // Cascade: remove all VMs on this node atomically
  data.vms = data.vms.filter((v) => v.nodeId !== req.params.id);
  data.nodes.splice(idx, 1);
  saveProxmox(data);
  res.json({ success: true });
});

// ─── Proxmox VM Routes ────────────────────────────────────────────────────────

app.get('/api/proxmox/vms', requireAuth, (_req, res) => {
  const { nodes, vms } = loadProxmox();
  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));
  res.json(vms.map((v) => ({ ...v, nodeName: nodeMap[v.nodeId]?.name || 'unknown' })));
});

app.post('/api/proxmox/vms', requireAuth, (req, res) => {
  const { name, vmid, nodeId } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.trim().length > 64) return res.status(400).json({ error: 'Name must be 64 characters or fewer' });
  if (!vmid) return res.status(400).json({ error: 'VM ID is required' });
  if (!/^\d+$/.test(String(vmid))) return res.status(400).json({ error: 'VM ID must be a positive integer' });
  if (!nodeId) return res.status(400).json({ error: 'Node is required' });

  const data = loadProxmox();
  const node = data.nodes.find((n) => n.id === nodeId);
  if (!node) return res.status(400).json({ error: 'Node not found' });

  const vm = {
    id: crypto.randomUUID(),
    name: name.trim(),
    vmid: String(vmid),
    nodeId,
    createdAt: new Date().toISOString(),
  };
  data.vms.push(vm);
  saveProxmox(data);
  res.status(201).json({ ...vm, nodeName: node.name });
});

app.put('/api/proxmox/vms/:id', requireAuth, (req, res) => {
  const { name, vmid, nodeId } = req.body;
  const data = loadProxmox();
  const idx = data.vms.findIndex((v) => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'VM not found' });

  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.trim().length > 64) return res.status(400).json({ error: 'Name must be 64 characters or fewer' });
  if (!vmid) return res.status(400).json({ error: 'VM ID is required' });
  if (!/^\d+$/.test(String(vmid))) return res.status(400).json({ error: 'VM ID must be a positive integer' });
  if (!nodeId) return res.status(400).json({ error: 'Node is required' });

  const node = data.nodes.find((n) => n.id === nodeId);
  if (!node) return res.status(400).json({ error: 'Node not found' });

  data.vms[idx] = { ...data.vms[idx], name: name.trim(), vmid: String(vmid), nodeId, updatedAt: new Date().toISOString() };
  saveProxmox(data);
  res.json({ ...data.vms[idx], nodeName: node.name });
});

app.delete('/api/proxmox/vms/:id', requireAuth, (req, res) => {
  const data = loadProxmox();
  const filtered = data.vms.filter((v) => v.id !== req.params.id);
  if (filtered.length === data.vms.length) return res.status(404).json({ error: 'VM not found' });
  data.vms = filtered;
  saveProxmox(data);
  res.json({ success: true });
});

app.get('/api/proxmox/vms/:id/status', requireAuth, async (req, res) => {
  const { nodes, vms } = loadProxmox();
  const vm = vms.find((v) => v.id === req.params.id);
  if (!vm) return res.status(404).json({ error: 'VM not found' });
  const node = nodes.find((n) => n.id === vm.nodeId);
  if (!node) return res.status(400).json({ error: 'Node not configured' });

  try {
    const result = await proxmoxRequest(node, 'GET', `/nodes/${node.name}/qemu/${vm.vmid}/status/current`);
    const { status, uptime } = result.data || {};
    res.json({ status: status || 'unknown', uptime: uptime || 0 });
  } catch (err) {
    // Return unknown rather than 500 so the UI handles it gracefully
    res.json({ status: 'unknown', uptime: 0, error: err.message });
  }
});

app.post('/api/proxmox/vms/:id/start', requireAuth, async (req, res) => {
  const { nodes, vms } = loadProxmox();
  const vm = vms.find((v) => v.id === req.params.id);
  if (!vm) return res.status(404).json({ error: 'VM not found' });
  const node = nodes.find((n) => n.id === vm.nodeId);
  if (!node) return res.status(400).json({ error: 'Node not configured' });

  try {
    await proxmoxRequest(node, 'POST', `/nodes/${node.name}/qemu/${vm.vmid}/status/start`);
    res.json({ success: true, message: `${vm.name} is starting` });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/proxmox/vms/:id/stop', requireAuth, async (req, res) => {
  const { nodes, vms } = loadProxmox();
  const vm = vms.find((v) => v.id === req.params.id);
  if (!vm) return res.status(404).json({ error: 'VM not found' });
  const node = nodes.find((n) => n.id === vm.nodeId);
  if (!node) return res.status(400).json({ error: 'Node not configured' });

  try {
    await proxmoxRequest(node, 'POST', `/nodes/${node.name}/qemu/${vm.vmid}/status/shutdown`, { timeout: 30 });
    res.json({ success: true, message: `${vm.name} is shutting down` });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Health & SPA Fallback ────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const { nodes, vms } = loadProxmox();
  res.json({ status: 'ok', devices: loadDevices().length, proxmoxNodes: nodes.length, proxmoxVMs: vms.length });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LANtern running on http://0.0.0.0:${PORT}`);
  console.log(`Devices file:  ${DEVICES_FILE}`);
  console.log(`Config file:   ${CONFIG_FILE}`);
  console.log(`Proxmox file:  ${PROXMOX_FILE}`);
});
