# Telegram VC's DDoS protection tool

![External Diagram](https://i.postimg.cc/WzYqYrk8/Screenshot-2026-06-19-002554.png)

Real-time DDoS protection for WebRTC / Telegram VC servers.  
Monitors traffic every second, auto-blocks attackers via `iptables`, sends Telegram alerts, and serves a live web dashboard.

[Click here to view deployed app](https://tg.helloevento.com)

---

## 5-Step Setup

### Step 1 — Clone / download to your VPS

```bash
git clone https://github.com/ankur-lakhmara/Telegram-VC-DDoS-Blocker.git /opt/vc-shield
cd /opt/vc-shield
```

Or copy the project files to `/opt/vc-shield` on your Ubuntu VPS.

---

### Step 2 — Configure `config.json`

```bash
nano config.json
```

| Field | What to set |
|---|---|
| `telegram.bot_token` | Create a bot via [@BotFather](https://t.me/BotFather) |
| `telegram.chat_id` | Your chat/group ID — get it from [@userinfobot](https://t.me/userinfobot) |
| `dashboard.password` | Change from the default `changeme123` |
| `network.interface` | Your VPS network interface (check with `ip link`) — usually `eth0` |
| `thresholds.*` | Tune sensitivity for your traffic levels |

---

### Step 3 — Run `setup.sh` as root

```bash
sudo bash setup.sh
```

This will:
- Install Node.js 18+
- Install `iptables` + `conntrack` + `iproute2`
- Create `/var/log/vc-shield/`
- Install npm dependencies (`express`, `ws`)
- Register a `systemd` service that auto-starts on reboot

---

### Step 4 — Start VC Shield

```bash
# Direct start
sudo node index.js start

# Or via systemd (recommended for production)
sudo systemctl start vc-shield
sudo systemctl status vc-shield
```

---

### Step 5 — Verify it's working

```bash
# Live status table
node index.js status

# Simulate a DDoS to test detection + Telegram + iptables
sudo node index.js test

# Open the dashboard in your browser
http://YOUR_VPS_IP:3000
```

---

## CLI Reference

```
node index.js start           Start monitoring + dashboard
node index.js stop            Graceful shutdown, flush iptables rules
node index.js status          Print live stats table
node index.js unblock <IP>    Manually remove an IP block
node index.js logs            Tail the event log in real time
node index.js test            Simulate an attack to verify the pipeline
```

---

## Dashboard

Open `http://YOUR_VPS_IP:3000` in any browser.

| Section | Shows |
|---|---|
| **Live VC Participants** | Unique IPs connected to WebRTC/STUN/TURN ports right now |
| **Stat cards** | Packets/sec, CPU %, active connections, blocked IPs |
| **Packet Rate chart** | 60-second rolling graph |
| **Top Connections** | IPs with the most open connections |
| **Blocked IPs table** | All blocked IPs, reason, timestamp, auto-unblock time, manual unblock button |
| **Live Event Log** | All BLOCKED / ALERT / INFO / ERROR events in real time |

---

## How It Works

```
node index.js start
  ├── firewall.setupWebRTCRules()    protect STUN/TURN/media ports
  ├── alerter.sendStartAlert()       notify Telegram
  ├── dashboard/server.js            serve dashboard on :3000 via WebSocket
  └── monitor.startMonitor()         setInterval every 1 s
        ├── ss -tn   → connections per IP
        ├── /proc/net/dev → packet rate
        ├── /proc/stat   → CPU usage
        ├── ss -un   → VC participants (WebRTC UDP connections)
        └── detector.analyze()
              └── attack found?
                    ├── firewall.blockIP(ip)        → iptables -I INPUT -s IP -j DROP
                    ├── alerter.sendAttackAlert()   → Telegram message
                    ├── logger.log()                → /var/log/vc-shield/events.log
                    └── setTimeout(unblockIP, 10m)  → auto-unblock
```

---

## Production Notes

- **Root required** — `iptables` commands need root. Use `sudo node index.js start` or the systemd service.
- **Linux only** — reads `/proc/net/dev`, `/proc/stat`, uses `ss` and `iptables`. Requires Ubuntu/Debian.
- **Node 18+** — uses built-in `fetch()`. The `setup.sh` installs this.
- **Telegram bot** — create via [@BotFather](https://t.me/BotFather), get your chat ID via [@userinfobot](https://t.me/userinfobot).
- **Firewall persistence** — install `iptables-persistent` if you want base rules to survive reboots.
- **Dashboard security** — expose port 3000 only via VPN or put nginx + HTTPS in front in production.

---

## File Structure

```
vc-shield-node/
├── index.js          CLI entry point (start/stop/status/unblock/logs/test)
├── monitor.js        Metrics collector — polls every 1 s
├── detector.js       Attack detection + auto-block + auto-unblock logic
├── firewall.js       iptables wrapper (block/unblock/setupWebRTC/flush)
├── alerter.js        Telegram alerts via built-in fetch()
├── logger.js         File + colour console logger
├── config.js         Loads and validates config.json
├── events.js         Internal event bus (EventEmitter) for dashboard sync
├── config.json       All settings — edit this first
├── package.json
├── setup.sh          One-command Ubuntu setup
└── dashboard/
    ├── server.js     Express + WebSocket server for real-time dashboard
    └── public/
        └── index.html  Full SPA dashboard (Chart.js, WebSocket, dark theme)
```

---

## Thresholds (config.json)

| Key | Default | Meaning |
|---|---|---|
| `max_conn_per_ip` | 50 | Connections from one IP before blocking |
| `max_packets_per_sec` | 1000 | Global packet rate before flood alert |
| `max_new_conn_per_sec` | 200 | New connections per second threshold |
| `cpu_alert_percent` | 85 | CPU % that triggers a warning alert |
| `auto_unblock_minutes` | 10 | Minutes until a blocked IP is released |

Tune these based on your expected legitimate traffic volume.
