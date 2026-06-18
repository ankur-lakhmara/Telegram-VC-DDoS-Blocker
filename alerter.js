'use strict';
const config = require('./config');

const { bot_token, chat_id, group_id } = config.telegram || {};

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function sendTo(target_id, text) {
  const url  = `https://api.telegram.org/bot${bot_token}/sendMessage`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: target_id, text, parse_mode: 'Markdown' }),
      signal:  ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Alerter: Telegram HTTP ${res.status} to ${target_id}: ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    const label = err.name === 'AbortError' ? 'timeout' : err.message;
    console.error(`Alerter: Failed to send — ${label}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function send(text) {
  if (!bot_token) return;

  // Try personal chat first; if it fails (e.g. user hasn't sent /start),
  // fall back to the group so alerts are never silently lost
  if (chat_id) {
    const ok = await sendTo(chat_id, text);
    if (ok) return;
  }

  if (group_id && group_id !== chat_id) {
    await sendTo(group_id, text);
  }
}

// ── public alert types ────────────────────────────────────────────────────────

async function sendAttackAlert(ip, type, value) {
  const min = config.thresholds.auto_unblock_minutes;
  return send(
`🚨 *DDoS ATTACK DETECTED*
🕐 \`${ts()}\`
🔴 IP Blocked: \`${ip}\`
⚡ Type: \`${type}\`
📊 Value: \`${value}\`
✅ Auto-blocked via iptables
⏱ Auto-unblock in: ${min} minutes`
  );
}

async function sendWarningAlert(type, value) {
  return send(
`⚠️ *WARNING*
🕐 \`${ts()}\`
⚡ Type: \`${type}\`
📊 Value: \`${value}\`
ℹ️ No IP blocked — system-level alert`
  );
}

async function sendStartAlert() {
  return send(
`🛡 *VC Shield ACTIVE*
🕐 \`${ts()}\`
✅ DDoS monitoring started
🔍 Watching WebRTC / Telegram VC traffic`
  );
}

async function sendStopAlert() {
  return send(
`🔒 *VC Shield STOPPED*
🕐 \`${ts()}\`
🧹 Firewall rules flushed`
  );
}

module.exports = { sendAttackAlert, sendWarningAlert, sendStartAlert, sendStopAlert };
