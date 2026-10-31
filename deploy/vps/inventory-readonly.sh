#!/usr/bin/env bash
# READ-ONLY inventory of the operator's existing VPS, to decide whether and where an isolated
# Shadow Swap static site could live WITHOUT touching the service already running there.
#
# It only reads. It does not start, stop, reload, restart, install, edit, or delete anything,
# and it prints no secret values (environment files and keys are listed by NAME, never read).
# Review it before running. Run as the normal admin user; commands needing root use `sudo -n`
# and are skipped (not prompted) if sudo would ask for a password.
#
#   bash inventory-readonly.sh > shadow-swap-vps-inventory.txt 2>&1
#
# Share the output only after reading it: hostnames and ports are infrastructure details.
set -u
section() { printf '\n===== %s =====\n' "$1"; }
try() { echo "\$ $*"; "$@" 2>&1 | sed 's/^/    /' || true; }
sudo_try() { if sudo -n true 2>/dev/null; then try sudo -n "$@"; else echo "\$ sudo $* (skipped: needs a password; run manually if wanted)"; fi; }

section "host"
try uname -a
try cat /etc/os-release
try uptime
try nproc
try free -h
try df -h -x tmpfs -x devtmpfs

section "listening sockets (what already owns which port)"
sudo_try ss -tlnp
try ss -tln

section "systemd services (names and state only)"
try systemctl list-units --type=service --state=running --no-pager --no-legend
try systemctl list-unit-files --type=service --state=enabled --no-pager --no-legend

section "reverse proxy / web server present?"
for b in nginx caddy apache2 httpd traefik haproxy cloudflared docker podman; do printf '%-12s %s\n' "$b" "$(command -v "$b" || echo '-')"; done
try nginx -v
# `nginx -T` prints the full effective config (READ-ONLY; it does not reload). It can contain
# credentials of the EXISTING service (auth headers, upstream tokens): redact before sharing.
sudo_try nginx -T
try caddy version
try ls -la /etc/caddy /etc/nginx/sites-enabled /etc/nginx/conf.d

section "Cloudflare Tunnel (configuration names only)"
try cloudflared --version
try ls -la /etc/cloudflared ~/.cloudflared
sudo_try systemctl status cloudflared --no-pager

section "containers (names, images, ports, limits)"
try docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
try docker network ls
try docker compose ls
try docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'

section "firewall"
sudo_try ufw status verbose
sudo_try nft list ruleset

section "candidate isolated paths (existence only)"
try ls -ld /srv /srv/* /var/www /var/www/*
try id
try getent passwd shadow-swap

section "TLS certificates (names and expiry only, no key material)"
sudo_try find /etc/letsencrypt/live -maxdepth 1 -type d
sudo_try find /etc/ssl/certs -maxdepth 1 -newer /etc/os-release -name '*.pem'

echo; echo "Inventory complete. Nothing was changed."
