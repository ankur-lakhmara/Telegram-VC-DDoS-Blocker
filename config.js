'use strict';
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`ERROR: config.json not found at ${CONFIG_PATH}`);
  console.error('Copy config.json.example and fill in your values.');
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(CONFIG_PATH, 'utf8');
} catch (err) {
  console.error('ERROR: Cannot read config.json:', err.message);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  console.error('ERROR: Invalid JSON in config.json:', err.message);
  process.exit(1);
}

// Required sections
for (const section of ['network', 'thresholds', 'log_dir']) {
  if (!cfg[section]) {
    console.error(`ERROR: config.json is missing required section: "${section}"`);
    process.exit(1);
  }
}

// Warn if Telegram not configured
if (!cfg.telegram?.bot_token || !cfg.telegram?.chat_id) {
  console.warn('WARNING: Telegram not configured — Telegram alerts will be skipped.');
}

module.exports = cfg;
