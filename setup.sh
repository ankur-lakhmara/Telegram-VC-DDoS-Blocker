#!/bin/bash
# vc-shield-node setup
# Ubuntu 22.04 / 24.04 — run as root
#
# What this does:
#   1. Installs Node.js (if <18), Nginx, Certbot, tools  — with visible output
#   2. Two-phase Nginx config: HTTP-only first, full SSL+proxy after cert is issued
#   3. Gets Let's Encrypt SSL cert via webroot challenge (certbot never touches our nginx config)
#   4. Blocks port 6398 from the internet (UFW + iptables)
#   5. Adds HTTP Basic Auth on the dashboard
#   6. Creates systemd service

set -e

# Prevents apt from asking interactive questions (e.g. "keep existing config?")
export DEBIAN_FRONTEND=noninteractive

# ─────────────────────────────────────────────────────────────────
#  CONFIGURE BEFORE RUNNING
# ─────────────────────────────────────────────────────────────────
DOMAIN="tg.helloevento.com" #ENTER YOUR DOMAIN YOU WANT TO ADD...
CERTBOT_EMAIL=""        # your email — Let's Encrypt sends renewal warnings here
DASH_USER="admin"       # dashboard login username
DASH_PASS=""            # dashboard password (leave blank → prompted)
DASHBOARD_PORT=6398     # stays internal; never exposed to the internet
# ─────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "\n${CYAN}══ $* ══${NC}"; }

# ── Root check ────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || error "Run as root:  sudo bash setup.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Collect missing config interactively ─────────────────────────
if [ -z "$CERTBOT_EMAIL" ]; then
  read -rp "  Email for Let's Encrypt renewal notices: " CERTBOT_EMAIL
  [ -z "$CERTBOT_EMAIL" ] && error "Email is required."
fi

if [ -z "$DASH_PASS" ]; then
  read -rsp "  Set dashboard password (username: $DASH_USER): " DASH_PASS
  echo ""
  [ -z "$DASH_PASS" ] && error "Dashboard password cannot be empty."
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "Step 1/7 — Installing packages  (output visible — may take 1-2 min)"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

info "Refreshing package index..."
apt-get update

# Check Node.js version — user already has v20 so this will skip
NODE_MAJOR=0
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
fi

if [ "$NODE_MAJOR" -lt 18 ]; then
  info "Installing Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y \
    -o Dpkg::Options::="--force-confdef" \
    -o Dpkg::Options::="--force-confold" \
    nodejs
else
  info "Node.js v${NODE_MAJOR} already installed — skipping"
fi

info "Installing Nginx, Certbot, apache2-utils, iptables tools..."
# NOTE: output is intentionally visible so you can see download progress
apt-get install -y \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  nginx \
  certbot \
  python3-certbot-nginx \
  apache2-utils \
  iptables conntrack iproute2 \
  ufw \
  curl

info "All packages installed ✓"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "Step 2/7 — Log directory + npm dependencies"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mkdir -p /var/log/vc-shield
chmod 755 /var/log/vc-shield
info "Log dir ready: /var/log/vc-shield"

info "Installing npm packages (express, ws)..."
npm install --production
info "npm packages installed ✓"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "Step 3/7 — Firewall (UFW + iptables)"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Allow essential ports FIRST — so SSH stays open when UFW enables
ufw allow 22/tcp   comment "SSH"   2>/dev/null || true
ufw allow 80/tcp   comment "HTTP"  2>/dev/null || true
ufw allow 443/tcp  comment "HTTPS" 2>/dev/null || true

# Block port 6398 from the internet — Nginx is the only allowed path in
ufw deny "${DASHBOARD_PORT}/tcp" comment "VC Shield dashboard internal-only" 2>/dev/null || true

# Belt-and-suspenders: also block via iptables directly
# Allow loopback (127.0.0.1 → 6398 so Nginx can proxy)
iptables -C INPUT -p tcp --dport "${DASHBOARD_PORT}" -s 127.0.0.1 -j ACCEPT 2>/dev/null || \
  iptables -A INPUT -p tcp --dport "${DASHBOARD_PORT}" -s 127.0.0.1 -j ACCEPT
# Drop everything else hitting port 6398
iptables -C INPUT -p tcp --dport "${DASHBOARD_PORT}" -j DROP 2>/dev/null || \
  iptables -A INPUT -p tcp --dport "${DASHBOARD_PORT}" -j DROP

# Enable UFW non-interactively (SSH rule already in place above)
ufw --force enable 2>/dev/null || true

info "UFW enabled — open ports: 22/SSH  80/HTTP  443/HTTPS"
info "Port ${DASHBOARD_PORT} BLOCKED from internet — Nginx-only access ✓"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "Step 4/7 — Nginx Phase 1: HTTP-only config (needed for SSL challenge)"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NGINX_CONF="/etc/nginx/sites-available/vc-shield"
HTPASSWD_FILE="/etc/nginx/.vc-shield-htpasswd"

# Create htpasswd file for Basic Auth
htpasswd -bc "$HTPASSWD_FILE" "$DASH_USER" "$DASH_PASS"
info "Basic Auth created — user: ${DASH_USER}"

# Make sure webroot dir exists for ACME challenge
mkdir -p /var/www/html

# Phase 1: minimal HTTP config that allows certbot to verify domain ownership.
# No SSL references here — cert doesn't exist yet.
cat > "$NGINX_CONF" << 'PHASE1'
# vc-shield — Phase 1: HTTP only (certbot ACME challenge + temp dashboard)
# This will be replaced with full SSL config after the certificate is issued.

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name PLACEHOLDER_DOMAIN;

    # Let's Encrypt webroot challenge — must NOT require auth
    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
        auth_basic off;   # bypass Basic Auth so Let's Encrypt can verify
    }

    # Dashboard behind Basic Auth
    auth_basic           "VC Shield Dashboard";
    auth_basic_user_file PLACEHOLDER_HTPASSWD;

    location / {
        proxy_pass         http://127.0.0.1:PLACEHOLDER_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_buffering    off;
    }
}
PHASE1

# Substitute the placeholders (avoids heredoc escaping complexity)
sed -i "s|PLACEHOLDER_DOMAIN|${DOMAIN}|g"       "$NGINX_CONF"
sed -i "s|PLACEHOLDER_HTPASSWD|${HTPASSWD_FILE}|g" "$NGINX_CONF"
sed -i "s|PLACEHOLDER_PORT|${DASHBOARD_PORT}|g" "$NGINX_CONF"

# Enable our site, disable the default nginx placeholder page
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/vc-shield
rm -f /etc/nginx/sites-enabled/default

nginx -t   # will print OK or the exact error
systemctl enable nginx
systemctl restart nginx

info "Nginx started with Phase 1 HTTP config ✓"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "Step 5/7 — Let's Encrypt SSL certificate for ${DOMAIN}"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CERTBOT_SUCCESS=false

# --webroot: certbot writes a challenge file under /var/www/html,
#            Nginx serves it over HTTP, Let's Encrypt verifies it.
#            Certbot does NOT touch our Nginx config — we control it completely.
if certbot certonly \
    --webroot \
    --webroot-path /var/www/html \
    --non-interactive \
    --agree-tos \
    --email "${CERTBOT_EMAIL}" \
    -d "${DOMAIN}"; then

  CERTBOT_SUCCESS=true
  info "SSL certificate issued for ${DOMAIN} ✓"

  # ── Phase 2: Replace HTTP config with full HTTPS + proxy config ──
  info "Writing Phase 2 Nginx config (HTTPS + WebSocket proxy)..."

  cat > "$NGINX_CONF" << 'PHASE2'
# vc-shield — Phase 2: Full HTTPS + WebSocket reverse proxy

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# Redirect all plain HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name PLACEHOLDER_DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name PLACEHOLDER_DOMAIN;

    # ── SSL certificate (issued by Let's Encrypt via certbot) ─────
    ssl_certificate     /etc/letsencrypt/live/PLACEHOLDER_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/PLACEHOLDER_DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # ── Security headers ──────────────────────────────────────────
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Frame-Options           "SAMEORIGIN"  always;
    add_header X-Content-Type-Options    "nosniff"     always;
    add_header Referrer-Policy           "no-referrer" always;

    # ── HTTP Basic Auth for dashboard ─────────────────────────────
    auth_basic           "VC Shield Dashboard";
    auth_basic_user_file PLACEHOLDER_HTPASSWD;

    # ── Reverse proxy → Node.js (HTTP + WebSocket) ────────────────
    location / {
        proxy_pass         http://127.0.0.1:PLACEHOLDER_PORT;
        proxy_http_version 1.1;

        # Required for WebSocket upgrade
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Pass real client IP to Node.js
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Keep WebSocket alive indefinitely
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        # Real-time — disable buffering
        proxy_buffering off;
        proxy_cache     off;
    }
}
PHASE2

  sed -i "s|PLACEHOLDER_DOMAIN|${DOMAIN}|g"          "$NGINX_CONF"
  sed -i "s|PLACEHOLDER_HTPASSWD|${HTPASSWD_FILE}|g" "$NGINX_CONF"
  sed -i "s|PLACEHOLDER_PORT|${DASHBOARD_PORT}|g"    "$NGINX_CONF"

  nginx -t   # verify before reloading
  systemctl reload nginx
  info "Nginx reloaded with full HTTPS config ✓"

  # Auto-renewal cron (certbot also installs a systemd timer, but cron is a fallback)
  if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --webroot --webroot-path /var/www/html && systemctl reload nginx") | crontab -
    info "SSL auto-renewal cron added (runs daily at 3 AM) ✓"
  fi

else
  warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  warn " Certbot could not get a certificate."
  warn " Most likely cause: DNS A record hasn't propagated yet."
  warn ""
  warn " Check if it's propagated: dig +short ${DOMAIN}"
  warn " (It should return your server IP)"
  warn ""
  warn " Once DNS is live, run this command to get the cert:"
  warn ""
  warn "   certbot certonly --webroot --webroot-path /var/www/html \\"
  warn "     --non-interactive --agree-tos \\"
  warn "     --email ${CERTBOT_EMAIL} -d ${DOMAIN}"
  warn ""
  warn " Then apply the full Nginx config:"
  warn "   bash ${SCRIPT_DIR}/setup.sh  (re-running is safe)"
  warn " Or just manually reload: systemctl reload nginx"
  warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  warn " Dashboard is accessible over HTTP in the meantime:"
  warn "   http://${DOMAIN}"
  warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "Step 6/7 — systemd service (auto-start on reboot)"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cat > /etc/systemd/system/vc-shield.service << SVCEOF
[Unit]
Description=VC Shield — WebRTC / Telegram VC DDoS Protection
After=network.target nginx.service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/usr/bin/node ${SCRIPT_DIR}/index.js start
ExecStop=/bin/kill -SIGTERM \$MAINPID
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vc-shield

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable vc-shield
info "systemd service registered (auto-starts on reboot) ✓"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "Step 7/7 — Done"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Ankur VC's DDoS Tool Setup Complete! ✅                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

if [ "$CERTBOT_SUCCESS" = true ]; then
  echo -e "  Dashboard: ${GREEN}https://${DOMAIN}${NC}  ✅ HTTPS"
else
  echo -e "  Dashboard: ${YELLOW}http://${DOMAIN}${NC}  ⚠ HTTP only (cert pending)"
fi

echo ""
echo -e "  Login:     ${DASH_USER} / [password you entered]"
echo -e "  Port 6398: ${RED}BLOCKED${NC} from internet — Nginx-only access"
echo ""
echo "  ─── Next steps ─────────────────────────────────────────────"
echo ""
echo "  1. Add your Telegram bot to config.json:"
echo "       nano ${SCRIPT_DIR}/config.json"
echo "       → telegram.bot_token   (from @BotFather)"
echo "       → telegram.chat_id     (from @userinfobot)"
echo ""
echo "  2. Start VC Shield:"
echo "       systemctl start vc-shield"
echo "       systemctl status vc-shield"
echo ""
echo "  3. Open dashboard:"
if [ "$CERTBOT_SUCCESS" = true ]; then
  echo "       https://${DOMAIN}"
else
  echo "       http://${DOMAIN}  (HTTPS once DNS propagates)"
fi
echo ""
echo "  ─── Useful commands ─────────────────────────────────────────"
echo "    journalctl -fu vc-shield           # live service logs"
echo "    node ${SCRIPT_DIR}/index.js status # stats table"
echo "    node ${SCRIPT_DIR}/index.js test   # simulate DDoS attack"
echo "    nginx -t && systemctl reload nginx  # after config changes"
echo "    certbot certificates                # check cert expiry"
echo ""
