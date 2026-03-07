const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = process.env.CONFIG_FILE || '/config/config.json';

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { pinHash: null };
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('[reset-pin] Could not read config file:', e.message);
    console.error('[reset-pin] Expected path:', CONFIG_FILE);
    process.exit(1);
  }
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const newPin = process.argv[2];
const config = loadConfig();

if (newPin === undefined) {
  config.pinHash = null;
  saveConfig(config);
  console.log('[reset-pin] PIN removed. The app is now accessible without a PIN.');
} else {
  if (!/^\d{4,8}$/.test(newPin)) {
    console.error('[reset-pin] Error: PIN must be 4–8 digits (numbers only).');
    process.exit(1);
  }
  config.pinHash = crypto.createHash('sha256').update(newPin).digest('hex');
  saveConfig(config);
  console.log('[reset-pin] PIN updated successfully.');
}
