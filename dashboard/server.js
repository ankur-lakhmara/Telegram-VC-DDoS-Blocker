'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const bus      = require('../events');
const firewall = require('../firewall');
const logger   = require('../logger');

const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
};

// In-process state mirrored for new WebSocket connections
const state = {
  startTime:      Date.now(),
  metrics:        {},
  packetsHistory: [],      // [{ t, v }] last 60 s
  blockedDetails: new Map(), // ip -> { blockedAt, reason }
  recentLogs:     [],
};

let wss = null;

// ── broadcast ─────────────────────────────────────────────────────────────────

function broadcast(type, data) {
  if (!wss) return;
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const c of wss.clients) {
    if (c.readyState === 1 /* OPEN */) c.send(msg);
  }
}

// ── event bus subscriptions ───────────────────────────────────────────────────

bus.on('metrics', (m) => {
  state.metrics = m;
  state.packetsHistory.push({ t: Date.now(), v: m.packetsPerSec });
  if (state.packetsHistory.length > 60) state.packetsHistory.shift();
  broadcast('metrics', m);
});

bus.on('block', (data) => {
  state.blockedDetails.set(data.ip, {
    blockedAt: data.blockedAt,
    reason:    data.reason || 'unknown',
  });
  broadcast('block', {
    ...data,
    blockedDetails: Object.fromEntries(state.blockedDetails),
  });
});

bus.on('unblock', (data) => {
  state.blockedDetails.delete(data.ip);
  broadcast('unblock', {
    ...data,
    blockedDetails: Object.fromEntries(state.blockedDetails),
  });
});

bus.on('log', (entry) => {
  state.recentLogs.unshift(entry);
  if (state.recentLogs.length > 300) state.recentLogs.pop();
  broadcast('log', entry);
});

// ── HTTP request handler ──────────────────────────────────────────────────────

function handleHTTP(req, res) {
  const url = new URL(req.url, 'http://x');

  // ── REST API ──
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const body = JSON.stringify({
      uptime:         Math.floor((Date.now() - state.startTime) / 1000),
      metrics:        state.metrics,
      packetsHistory: state.packetsHistory,
      blockedIPs:     firewall.getBlockedIPs(),
      blockedDetails: Object.fromEntries(state.blockedDetails),
      recentLogs:     state.recentLogs.slice(0, 100),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (url.pathname === '/api/unblock' && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const { ip } = JSON.parse(body);
        const result = firewall.unblockIP(ip);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Static files ──
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(PUBLIC, filePath);

  // Path traversal guard
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}

// ── public ────────────────────────────────────────────────────────────────────

function start(port = 6398) {
  const server = http.createServer(handleHTTP);
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    // Send full state snapshot to new client
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        uptime:         Math.floor((Date.now() - state.startTime) / 1000),
        metrics:        state.metrics,
        packetsHistory: state.packetsHistory,
        blockedIPs:     firewall.getBlockedIPs(),
        blockedDetails: Object.fromEntries(state.blockedDetails),
        recentLogs:     state.recentLogs.slice(0, 100),
      },
    }));

    ws.on('message', (raw) => {
      try {
        const { type, data } = JSON.parse(raw);
        if (type === 'unblock' && data?.ip) {
          const r = firewall.unblockIP(data.ip);
          ws.send(JSON.stringify({ type: 'unblock_result', data: r }));
        }
        // Manual VC toggle — fallback when Telegram service messages don't arrive
        if (type === 'set_vc') {
          const active = !!data?.active;
          bus.emit('override_vc', { active });
          broadcast('vc_override', { active });
        }
      } catch {}
    });

    ws.on('error', () => {});
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`\x1b[36m📊 Dashboard → http://localhost:${port}\x1b[0m`);
  });

  return server;
}

module.exports = { start };
