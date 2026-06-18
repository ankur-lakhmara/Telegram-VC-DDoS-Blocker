'use strict';
const fs   = require('fs');
const path = require('path');

// ANSI colour codes — no external deps needed
const C = {
  RESET:   '\x1b[0m',
  BLOCKED: '\x1b[31m',   // red
  ALERT:   '\x1b[33m',   // yellow
  INFO:    '\x1b[32m',   // green
  ERROR:   '\x1b[35m',   // magenta
};

let logFile = null;

function init(logDir) {
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'events.log');
  } catch (err) {
    console.error('Logger: cannot create log dir:', err.message);
  }
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, ...args) {
  const msg  = args.join(' ');
  const line = `[${ts()}] [${level}] ${msg}`;
  const col  = C[level] || C.RESET;

  console.log(`${col}${line}${C.RESET}`);

  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  }

  // Broadcast to dashboard
  try {
    require('./events').emit('log', {
      level,
      message: msg,
      timestamp: new Date().toISOString(),
    });
  } catch {}
}

function getRecentLogs(n = 50) {
  if (!logFile || !fs.existsSync(logFile)) return [];
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    return lines.slice(-n);
  } catch {
    return [];
  }
}

module.exports = { init, log, getRecentLogs };
