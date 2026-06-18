'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PID_FILE     = '/tmp/vc-shield.pid';
const METRICS_FILE = '/tmp/vc-shield-metrics.json';

const cmd = process.argv[2];

(async () => {
  switch (cmd) {
    case 'start':   await cmdStart();               break;
    case 'stop':    await cmdStop();                break;
    case 'status':  await cmdStatus();              break;
    case 'unblock': await cmdUnblock(process.argv[3]); break;
    case 'logs':    await cmdLogs();                break;
    case 'test':    await cmdTest();                break;
    default:
      console.log([
        '',
        '  \x1b[36mvc-shield-node\x1b[0m — WebRTC / Telegram VC DDoS Protection',
        '',
        '  Commands:',
        '    node index.js start           Start monitoring + dashboard',
        '    node index.js stop            Stop monitoring, flush rules',
        '    node index.js status          Show live stats table',
        '    node index.js unblock <IP>    Manually unblock an IP',
        '    node index.js logs            Tail the event log',
        '    node index.js test            Simulate a DDoS attack',
        '',
      ].join('\n'));
      process.exit(cmd ? 1 : 0);
  }
})().catch(err => {
  console.error('\x1b[31mFatal:\x1b[0m', err.message);
  process.exit(1);
});

// ── start ─────────────────────────────────────────────────────────────────────

async function cmdStart() {
  // Check already running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      console.error(`\x1b[31mVC Shield is already running (PID ${pid}).\x1b[0m Run "node index.js stop" first.`);
      process.exit(1);
    } catch {
      fs.unlinkSync(PID_FILE); // stale PID, clean up
    }
  }

  const cfg      = require('./config');
  const logger   = require('./logger');
  const firewall = require('./firewall');
  const alerter  = require('./alerter');
  const monitor  = require('./monitor');

  logger.init(cfg.log_dir);
  fs.writeFileSync(PID_FILE, String(process.pid));

  const shutdown = async (sig) => {
    logger.log('INFO', `Signal ${sig} received — shutting down`);
    monitor.stopMonitor();
    firewall.flushToolRules();
    await alerter.sendStopAlert();
    [PID_FILE, METRICS_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  console.log('\x1b[32m🛡  VC Shield starting...\x1b[0m');

  firewall.setupWebRTCRules();

  // Dashboard
  if (cfg.dashboard?.enabled !== false) {
    const port = cfg.dashboard?.port || 6398;
    const pass = cfg.dashboard?.password || '';
    try {
      const dashServer = require('./dashboard/server');
      dashServer.start(port, pass);
    } catch (err) {
      logger.log('ERROR', `Dashboard failed to start: ${err.message}`);
    }
  }

  await alerter.sendStartAlert();
  monitor.startMonitor();

  const dashPort = cfg.dashboard?.port || 6398;
  logger.log('INFO', `VC Shield active — dashboard at http://localhost:${dashPort}`);
  console.log(`\x1b[32m✅ Running. Dashboard → \x1b[36mhttp://localhost:${dashPort}\x1b[0m`);
}

// ── stop ──────────────────────────────────────────────────────────────────────

async function cmdStop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('VC Shield is not running.');
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  console.log(`Stopping VC Shield (PID ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    console.log('✅ Stop signal sent.');
  } catch (err) {
    console.error(`Could not signal process: ${err.message}`);
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('\x1b[31m● VC Shield is STOPPED\x1b[0m');
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}

  if (!alive) {
    console.log('\x1b[31m● VC Shield is STOPPED (stale PID file)\x1b[0m');
    return;
  }

  console.log(`\x1b[32m● VC Shield is RUNNING (PID ${pid})\x1b[0m`);

  if (!fs.existsSync(METRICS_FILE)) return;
  try {
    const m = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    const up = fmtUptime(m.uptime || 0);
    const rows = [
      ['Uptime',          up],
      ['CPU Usage',       `${(m.cpuPercent || 0).toFixed(1)} %`],
      ['Packets / sec',   String(m.packetsPerSec  || 0)],
      ['Active Conns',    String(m.totalConnections || 0)],
      ['VC Participants', String(m.vcParticipants || 0)],
      ['Blocked IPs',     String(m.blockedCount || 0)],
    ];
    console.log('');
    console.log('  ┌──────────────────────────────────────┐');
    console.log('  │         VC Shield  Status            │');
    console.log('  ├──────────────────────────────────────┤');
    rows.forEach(([k, v]) => {
      console.log(`  │  ${k.padEnd(18)} ${v.padEnd(18)}│`);
    });
    console.log('  └──────────────────────────────────────┘');
    console.log('');
  } catch {}
}

// ── unblock ───────────────────────────────────────────────────────────────────

async function cmdUnblock(ip) {
  if (!ip) { console.error('Usage: node index.js unblock <IP>'); process.exit(1); }
  const firewall = require('./firewall');
  const logger   = require('./logger');
  const cfg      = require('./config');
  logger.init(cfg.log_dir);
  const r = firewall.unblockIP(ip);
  console.log(r.success ? `✅ Unblocked: ${ip}` : `❌ Failed: ${r.error || r.reason}`);
}

// ── logs ──────────────────────────────────────────────────────────────────────

async function cmdLogs() {
  const cfg     = require('./config');
  const logPath = path.join(cfg.log_dir, 'events.log');

  if (!fs.existsSync(logPath)) {
    console.log('No log file yet. Start the monitor first.');
    return;
  }

  // Print last 50 lines
  try {
    console.log(execSync(`tail -50 "${logPath}"`, { encoding: 'utf8' }));
  } catch {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-50);
    console.log(lines.join('\n'));
  }

  // Watch for new entries
  console.log('\x1b[33m--- Watching (Ctrl+C to stop) ---\x1b[0m');
  let lastSize = fs.statSync(logPath).size;
  setInterval(() => {
    try {
      const { size } = fs.statSync(logPath);
      if (size <= lastSize) return;
      const fd  = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      process.stdout.write(buf.toString());
      lastSize = size;
    } catch {}
  }, 400);
}

// ── test ──────────────────────────────────────────────────────────────────────

async function cmdTest() {
  const cfg     = require('./config');
  const logger  = require('./logger');
  const firewall = require('./firewall');
  const AttackDetector = require('./detector');

  logger.init(cfg.log_dir);

  console.log('\x1b[33m⚡ Running DDoS simulation...\x1b[0m');

  // RFC 5737 TEST-NET — safe, non-routable test addresses
  const testIPs = ['203.0.113.10', '203.0.113.20', '203.0.113.30'];
  const fakeConns = cfg.thresholds.max_conn_per_ip + 25;

  const det = new AttackDetector();
  const ipConnections = new Map(testIPs.map(ip => [ip, fakeConns]));

  const metrics = {
    ipConnections,
    packetsPerSec: cfg.thresholds.max_packets_per_sec + 500,
    cpuPercent:    45,
    vcParticipants: 12,
    totalConnections: testIPs.length * fakeConns,
    timestamp: new Date(),
  };

  console.log(`📊 Simulating ${fakeConns} conns/IP from ${testIPs.length} test IPs...`);
  det.analyze(metrics);

  await new Promise(r => setTimeout(r, 2000));

  console.log('');
  console.log('\x1b[32m✅ Test complete! Verify:\x1b[0m');
  console.log(`  1. Telegram → you should have an attack alert`);
  testIPs.forEach(ip => console.log(`  2. iptables -L INPUT -n | grep ${ip}`));
  console.log(`  3. Log: ${path.join(cfg.log_dir, 'events.log')}`);
  console.log(`\n\x1b[33m  Test IPs auto-unblock in ${cfg.thresholds.auto_unblock_minutes} min.\x1b[0m`);
  setTimeout(() => process.exit(0), 3000);
}

// ── util ──────────────────────────────────────────────────────────────────────

function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}
