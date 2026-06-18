'use strict';
const { execSync } = require('child_process');
const config = require('./config');

const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

const blockedIPs  = new Set();
const webrtcRules = []; 

// ── helpers ──────────────────────────────────────────────────────────────────

function run(cmd, label) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000 });
  } catch (err) {
    throw new Error(`Firewall [${label}]: ${err.stderr?.trim() || err.message}`);
  }
}

function validateIP(ip) {
  if (!IP_REGEX.test(ip)) throw new Error(`Invalid IP: "${ip}"`);
  if (ip.split('.').map(Number).some(n => n > 255)) throw new Error(`Invalid IP: "${ip}"`);
}

function logger() { return require('./logger'); }
function bus()    { return require('./events');  }

// ── public API ────────────────────────────────────────────────────────────────

function blockIP(ip, reason = 'detected') {
  try {
    validateIP(ip);
  } catch (err) {
    logger().log('ERROR', err.message);
    return { success: false, ip, error: err.message };
  }

  if (blockedIPs.has(ip)) return { success: false, ip, reason: 'already blocked' };

  try {
    run(`iptables -I INPUT -s ${ip} -j DROP`, `block ${ip}`);
    blockedIPs.add(ip);
    const blockedAt = new Date().toISOString();
    bus().emit('block', { ip, blockedAt, reason });
    return { success: true, ip, blockedAt };
  } catch (err) {
    logger().log('ERROR', `blockIP ${ip}: ${err.message}`);
    return { success: false, ip, error: err.message };
  }
}

function unblockIP(ip) {
  try {
    validateIP(ip);
  } catch (err) {
    return { success: false, ip, error: err.message };
  }

  try {
    run(`iptables -D INPUT -s ${ip} -j DROP`, `unblock ${ip}`);
  } catch {
  
  }

  blockedIPs.delete(ip);
  const unblockedAt = new Date().toISOString();
  bus().emit('unblock', { ip, unblockedAt });
  logger().log('INFO', `Unblocked ${ip}`);
  return { success: true, ip, unblockedAt };
}

function getBlockedIPs() {
  try {
    const out = run('iptables -L INPUT -n --line-numbers', 'list');
    const ips = [];
    for (const line of out.split('\n')) {
      
      const m = line.match(/DROP\s+all\s+--\s+(\d+\.\d+\.\d+\.\d+)\s/);
      if (m) ips.push(m[1]);
    }
    return ips;
  } catch {
    return Array.from(blockedIPs);
  }
}

function setupWebRTCRules() {
  const net = config.network;
  const rules = [
    [`iptables -A INPUT -p udp --dport ${net.stun_port} -j ACCEPT`,                                 'STUN UDP'],
    [`iptables -A INPUT -p tcp --dport ${net.stun_port} -j ACCEPT`,                                 'TURN TCP'],
    [`iptables -A INPUT -p udp --dport ${net.turn_port_start}:${net.turn_port_end} -j ACCEPT`,      'WebRTC media'],
    [`iptables -A INPUT -p tcp --dport ${net.signaling_port} -m connlimit --connlimit-above 20 -j DROP`, 'signaling rate-limit'],
  ];

  for (const [cmd, label] of rules) {
    try {
      run(cmd, label);
      webrtcRules.push(cmd);
      logger().log('INFO', `Firewall rule applied: ${label}`);
    } catch (err) {
      logger().log('ERROR', `Failed to apply rule [${label}]: ${err.message}`);
    }
  }
}

function flushToolRules() {
  // Remove per-IP blocks
  for (const ip of blockedIPs) {
    try { execSync(`iptables -D INPUT -s ${ip} -j DROP`, { stdio: 'pipe' }); } catch {}
  }
  blockedIPs.clear();

  // Remove WebRTC rules (replace -A with -D)
  for (const cmd of webrtcRules) {
    try { execSync(cmd.replace(/^iptables -A/, 'iptables -D'), { stdio: 'pipe' }); } catch {}
  }
  webrtcRules.length = 0;

  logger().log('INFO', 'All VC Shield iptables rules removed');
}

function getBlockedSet() { return blockedIPs; }

module.exports = { blockIP, unblockIP, getBlockedIPs, getBlockedSet, setupWebRTCRules, flushToolRules };
