'use strict';
const fs           = require('fs');
const { execSync } = require('child_process');
const config       = require('./config');
const AttackDetector = require('./detector');
const logger       = require('./logger');
const bus          = require('./events');

const detector   = new AttackDetector();
let   netInterval = null;
let   tgInterval  = null;
let   lastPkts    = null;
const startTime   = Date.now();

// Manual VC override from dashboard toggle button
bus.on('override_vc', ({ active }) => {
  tgState.vcActive    = active;
  tgState.vcStartedAt = active ? Date.now() : null;
  logger.log('INFO', `VC status manually set to: ${active ? 'ACTIVE 🎙' : 'INACTIVE 🔇'}`);
});

// ── Telegram group state (updated every 10 s via Bot API) ─────────────────────
// Telegram VCs don't route through this VPS — participants connect to Telegram's
// own servers. So we poll the Bot API for real data instead of reading local sockets.
const tgState = {
  memberCount:  0,
  vcActive:     false, 
  vcStartedAt:  null,    
  offset:       0,       
  ready:        false,   
};

async function initTgOffset() {
  const { bot_token, group_id, chat_id } = config.telegram;
  if (!bot_token) { tgState.ready = true; return; }

  const monitorId = String(group_id || chat_id || '');

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${bot_token}/getUpdates?limit=100&timeout=0`,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      let lastVCEventId = 0;

      for (const update of data.result) {
        const msg = update.message || update.channel_post;
        if (!msg) continue;

        // Only look at events from the monitored group
        const fromId = String(msg.chat?.id || '');
        if (monitorId && fromId !== monitorId) continue;

        if (update.update_id > lastVCEventId) {
          if (msg.video_chat_started || msg.voice_chat_started) {
            tgState.vcActive    = true;
            tgState.vcStartedAt = Date.now();
            lastVCEventId = update.update_id;
          }
          if (msg.video_chat_ended || msg.voice_chat_ended) {
            tgState.vcActive    = false;
            tgState.vcStartedAt = null;
            lastVCEventId = update.update_id;
          }
        }
      }

      if (tgState.vcActive) {
        logger.log('INFO', 'Init: Voice Chat is currently ACTIVE in group (detected from pending updates)');
      }

      // Advance offset past all these updates so pollTelegram only sees NEW events
      tgState.offset = data.result[data.result.length - 1].update_id;
    }
  } catch (err) {
    logger.log('ERROR', `initTgOffset failed: ${err.message}`);
  }

  tgState.ready = true;
}

async function pollTelegram() {
  const { bot_token, chat_id, group_id } = config.telegram;
  if (!bot_token || !tgState.ready) return;

  // Auto-reset VC state if it's been "active" for > 3 hours with no end event.
  // This handles the common case where video_chat_ended is never delivered (privacy
  // mode, network gap on restart, etc.) — without this, the badge stays green forever.
  if (tgState.vcActive && tgState.vcStartedAt) {
    if (Date.now() - tgState.vcStartedAt > 3 * 60 * 60 * 1000) {
      tgState.vcActive    = false;
      tgState.vcStartedAt = null;
      logger.log('INFO', 'VC auto-reset: active for > 3 h without end event — clearing state');
    }
  }

  // group_id = the group to monitor for VC events + member count
  // chat_id  = where to send alerts (can be personal)
  // If group_id not set, fall back to chat_id for member count
  const monitorId = group_id || chat_id;
  if (!monitorId) return;

  try {
    const id      = encodeURIComponent(monitorId);
    // Explicitly request message + channel_post so service messages
    // (video_chat_started/ended) are always included in the response
    const allowed = encodeURIComponent(JSON.stringify(['message', 'channel_post']));

    // Parallel: member count + new updates (voice-chat events)
    const [cRes, uRes] = await Promise.all([
      fetch(
        `https://api.telegram.org/bot${bot_token}/getChatMemberCount?chat_id=${id}`,
        { signal: AbortSignal.timeout(4000) }
      ),
      fetch(
        `https://api.telegram.org/bot${bot_token}/getUpdates?offset=${tgState.offset + 1}&timeout=0&limit=50&allowed_updates=${allowed}`,
        { signal: AbortSignal.timeout(4000) }
      ),
    ]);

    const [cData, uData] = await Promise.all([cRes.json(), uRes.json()]);

    if (cData.ok) {
      tgState.memberCount = cData.result;
    } else if (cData.description) {
      // Log once so user knows group_id may be wrong
      logger.log('ERROR', `Telegram getChatMemberCount: ${cData.description}`);
    }

    if (uData.ok) {
      for (const update of uData.result) {
        // Advance offset so we never re-process this update
        if (update.update_id > tgState.offset) tgState.offset = update.update_id;

        const msg = update.message || update.channel_post;
        if (!msg) continue;

        // Only process events from the monitored group
        const fromChatId = String(msg.chat?.id);
        if (fromChatId !== String(monitorId)) continue;

        // Telegram renamed voice_chat_* → video_chat_* in Bot API v5.6
        // Handle both names for compatibility
        if (msg.voice_chat_started || msg.video_chat_started) {
          tgState.vcActive    = true;
          tgState.vcStartedAt = Date.now();
          logger.log('INFO', 'Telegram Voice Chat STARTED in group');
        }
        if (msg.voice_chat_ended || msg.video_chat_ended) {
          tgState.vcActive    = false;
          tgState.vcStartedAt = null;
          logger.log('INFO', 'Telegram Voice Chat ENDED in group');
        }
      }
    }
  } catch { /* keep last known state — transient network error */ }
}

// ── Network metrics (read every 1 s from kernel) ──────────────────────────────

function getConnectionsPerIP() {
  const map = new Map();
  try {
    const out = execSync('ss -tn state established', {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000,
    });
    for (const line of out.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      // ss -tn state established format: Recv-Q  Send-Q  Local:Port  Peer:Port
      // State column is OMITTED when filtering by state — only 4 cols total
      // Peer address is always the LAST column regardless of ss version
      if (parts.length < 4) continue;
      const peer  = parts[parts.length - 1];
      if (!peer || !peer.includes(':')) continue;
      const colon = peer.lastIndexOf(':');
      const ip    = peer.slice(0, colon);
      // Skip loopback and IPv6 bracket notation
      if (!ip || ip.startsWith('[') || ip === '127.0.0.1' || ip === '::1') continue;
      map.set(ip, (map.get(ip) || 0) + 1);
    }
  } catch { /* ss unavailable */ }
  return map;
}

// Returns total packets/s on the configured interface.
// NOTE: this is ALL server traffic (SSH, HTTPS, system, bot connections, etc.)
// — not VC-only. A sudden spike indicates a flood/DDoS regardless of source.
function getPacketRate() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n');
    const iface = config.network.interface;
    for (const line of lines) {
      if (!line.includes(iface + ':')) continue;
      const cols  = line.split(':')[1].trim().split(/\s+/);
      const total = parseInt(cols[1], 10) + parseInt(cols[9], 10); // rx + tx packets
      if (lastPkts === null) { lastPkts = total; return 0; }
      const delta = Math.max(0, total - lastPkts);
      lastPkts = total;
      return delta;
    }
  } catch {}
  return 0;
}

function getCPUUsage() {
  try {
    const first = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const vals  = first.split(/\s+/).slice(1).map(Number);
    const idle  = vals[3] + (vals[4] || 0);
    const total = vals.reduce((a, b) => a + b, 0);
    return total > 0 ? 100 - (idle * 100 / total) : 0;
  } catch { return 0; }
}

function saveMetrics(m) {
  try {
    fs.writeFileSync('/tmp/vc-shield-metrics.json', JSON.stringify({
      uptime:           Math.floor((Date.now() - startTime) / 1000),
      packetsPerSec:    m.packetsPerSec,
      cpuPercent:       m.cpuPercent,
      memberCount:      m.memberCount,
      vcActive:         m.vcActive,
      totalConnections: m.totalConnections,
      blockedCount:     require('./firewall').getBlockedSet().size,
    }));
  } catch {}
}

// ── public API ─────────────────────────────────────────────────────────────────

function startMonitor() {
  logger.log('INFO', 'Monitor started — network polling every 1 s, Telegram polling every 10 s');

  // Init Telegram offset (skip old events), then start 10-second poll
  initTgOffset().then(() => {
    pollTelegram(); // first poll immediately after offset init
    tgInterval = setInterval(pollTelegram, 10_000);
  });

  // Network metrics every 1 second
  netInterval = setInterval(() => {
    const ipConnections    = getConnectionsPerIP();
    const packetsPerSec    = getPacketRate();
    const cpuPercent       = getCPUUsage();
    const totalConnections = [...ipConnections.values()].reduce((a, b) => a + b, 0);
    const timestamp        = new Date();

    const metrics = {
      ipConnections,
      packetsPerSec,
      cpuPercent,
      memberCount:      tgState.memberCount,
      vcActive:         tgState.vcActive,
      totalConnections,
      timestamp,
    };

    saveMetrics(metrics);

    bus.emit('metrics', {
      packetsPerSec,
      cpuPercent,
      memberCount:      tgState.memberCount,
      vcActive:         tgState.vcActive,
      totalConnections,
      blockedCount:     require('./firewall').getBlockedSet().size,
      timestamp:        timestamp.toISOString(),
      topIPs: [...ipConnections.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([ip, count]) => ({ ip, count })),
    });

    detector.analyze(metrics);
  }, 1000);
}

function stopMonitor() {
  if (netInterval) { clearInterval(netInterval); netInterval = null; }
  if (tgInterval)  { clearInterval(tgInterval);  tgInterval  = null; }
  logger.log('INFO', 'Monitor stopped');
}

module.exports = { startMonitor, stopMonitor, getConnectionsPerIP };
