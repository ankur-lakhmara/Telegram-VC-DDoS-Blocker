'use strict';
const config   = require('./config');
const firewall = require('./firewall');
const alerter  = require('./alerter');
const logger   = require('./logger');

const PRIVATE_PREFIXES = [
  (p) => p[0] === 127,
  (p) => p[0] === 10,
  (p) => p[0] === 172 && p[1] >= 16 && p[1] <= 31,
  (p) => p[0] === 192 && p[1] === 168,
];

function isPrivate(ip) {
  const p = ip.split('.').map(Number);
  return PRIVATE_PREFIXES.some(fn => fn(p));
}

class AttackDetector {
  constructor() {
    this.t             = config.thresholds;
    this.alertedIPs    = new Map(); 
    this.globalAlerts  = new Map(); 
    this.unblockTimers = new Map(); 
    this.prevIPCounts  = new Map(); 
    this.IP_COOLDOWN     = 60_000;
    this.GLOBAL_COOLDOWN = 5 * 60_000;

    this.BURST_THRESH = Math.max(5, Math.floor((this.t.max_new_conn_per_sec || 200) / 10));
  }

  analyze({ ipConnections, packetsPerSec, cpuPercent }) {
    let topIP    = null;
    let topCount = 0;

    if (ipConnections) {
      const baselineReady = this.prevIPCounts.size > 0; 

      for (const [ip, count] of ipConnections) {
        if (count > topCount) { topCount = count; topIP = ip; }

      
        if (count > this.t.max_conn_per_ip) {
          this.onAttack(ip, 'conn_flood', count);
        }

        if (baselineReady) {
          const burst = count - (this.prevIPCounts.get(ip) || 0);
          if (burst >= this.BURST_THRESH) {
            this.onAttack(ip, 'burst_flood', `${burst}/s`);
          }
        }
      }

      this.prevIPCounts = new Map(ipConnections); 
    }

    if (packetsPerSec > this.t.max_packets_per_sec) {
      if (topIP) this.onAttack(topIP, 'packet_flood', packetsPerSec);
      else       this.onAlert('packet_flood', packetsPerSec);
    }

    if (cpuPercent > this.t.cpu_alert_percent) {
      this.onAlert('cpu_spike', `${cpuPercent.toFixed(1)}%`);
    }
  }

  onAttack(ip, type, value) {
    if (isPrivate(ip)) return;
    if (firewall.getBlockedSet().has(ip)) return;

    const last = this.alertedIPs.get(ip);
    if (last && Date.now() - last < this.IP_COOLDOWN) return;

    this.alertedIPs.set(ip, Date.now());

    const result = firewall.blockIP(ip, `${type}:${value}`);
    if (!result.success) return;

    alerter.sendAttackAlert(ip, type, value).catch(() => {});
    logger.log('BLOCKED', ip, type, String(value));

    // Auto-unblock timer
    if (this.unblockTimers.has(ip)) clearTimeout(this.unblockTimers.get(ip));
    const timer = setTimeout(() => {
      firewall.unblockIP(ip);
      this.alertedIPs.delete(ip);
      this.unblockTimers.delete(ip);
      logger.log('INFO', `Auto-unblocked ${ip} after ${this.t.auto_unblock_minutes}m`);
    }, this.t.auto_unblock_minutes * 60_000);
    this.unblockTimers.set(ip, timer);
  }

  onAlert(type, value) {
    const last = this.globalAlerts.get(type);
    if (last && Date.now() - last < this.GLOBAL_COOLDOWN) return;
    this.globalAlerts.set(type, Date.now());

    alerter.sendWarningAlert(type, value).catch(() => {});
    logger.log('ALERT', type, String(value));
  }
}

module.exports = AttackDetector;
