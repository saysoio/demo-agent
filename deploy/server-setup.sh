#!/usr/bin/env bash
# One-time (and safe to re-run) setup of the demo box, as root, from a copy of this deploy/ folder:
#   scp -r deploy demo-vps:/root/demo-deploy && ssh demo-vps 'bash /root/demo-deploy/server-setup.sh'
#
#   --check               run what a container allows (packages, users, files); print, do not run, the steps that need
#                         systemd or the kernel (services, swap, firewall, sshd reload)
#   --disable-root-login  PermitRootLogin no. Only once `ssh demo@<box>` works; without it root keeps key-only login
#
# Settings (environment): DOCKER_MAJOR (29), DOCKER_CODENAME (this release's codename; set noble if Docker's repo
# lacks it), SWAP_SIZE (2G; 0 for none), DEMO_USER (demo).
#
# What it does: swap; unattended security upgrades; the deploy user with root's authorized_keys, in the docker group;
# sshd with keys only; Docker Engine and compose from Docker's apt repo (pinned major) with log rotation; containers kept
# off link-local and metadata addresses (DOCKER-USER, re-applied whenever Docker starts); Caddy from its apt repo with
# deploy/Caddyfile; the nftables firewall (22 open, 80/443 from Cloudflare only, everything else closed, 8787 never
# opened) refreshed daily from cloudflare.com. Prints no secrets; asks nothing.
set -euo pipefail

CHECK=0; NO_ROOT=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --disable-root-login) NO_ROOT=1 ;;
    *) echo "usage: server-setup.sh [--check] [--disable-root-login]" >&2; exit 2 ;;
  esac
done
DOCKER_MAJOR=${DOCKER_MAJOR:-29}
SWAP_SIZE=${SWAP_SIZE:-2G}
DEMO_USER=${DEMO_USER:-demo}
HERE=$(cd "$(dirname "$0")" && pwd)
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n== %s\n' "$*"; }
say() { echo "   $*"; }
die() { echo "server-setup: $*" >&2; exit 1; }
# steps that need systemd or the kernel: run them, or in --check print them
sys() { if [ "$CHECK" = 1 ]; then echo "   check, would run: $*"; else "$@"; fi; }
# writes stdin to a file only when it differs; returns 0 when it changed
put() {
  local f=$1 mode=${2:-0644} tmp
  tmp=$(mktemp); cat > "$tmp"
  if [ -f "$f" ] && cmp -s "$tmp" "$f"; then rm -f "$tmp"; return 1; fi
  install -D -m "$mode" "$tmp" "$f"; rm -f "$tmp"; say "wrote $f"; return 0
}
apt_install() { apt-get install -y -q -o Dpkg::Options::=--force-confold --no-install-recommends "$@" >/dev/null; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$HERE/cf-refresh.sh" ] && [ -f "$HERE/Caddyfile" ] || die "cf-refresh.sh and Caddyfile must sit next to this script (copy the whole deploy/ folder)"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script is for Ubuntu (found ${ID:-unknown})"
CODENAME=${DOCKER_CODENAME:-$VERSION_CODENAME}
if [ "$CHECK" = 0 ] && [ ! -d /run/systemd/system ]; then die "systemd is not running here; use --check"; fi
ARCH=$(dpkg --print-architecture)
echo "server-setup on $PRETTY_NAME ($ARCH)$([ "$CHECK" = 1 ] && echo ', CHECK MODE: no services, swap, firewall or sshd changes')"

step "swap ($SWAP_SIZE)"
if [ "$SWAP_SIZE" = 0 ]; then say "skipped (SWAP_SIZE=0)"
elif [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then say "swap is already on: $(swapon --show --noheadings | awk '{print $1, $3}' | paste -sd' ' -)"
else
  if [ ! -f /swapfile ]; then sys fallocate -l "$SWAP_SIZE" /swapfile; sys chmod 600 /swapfile; sys mkswap /swapfile; fi
  sys swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || sys sh -c 'echo "/swapfile none swap sw 0 0" >> /etc/fstab'
fi

step "packages"
apt-get update -q >/dev/null
apt_install ca-certificates curl gnupg git nftables iptables python3 unattended-upgrades sqlite3
say "base packages installed"

step "unattended security upgrades"
put /etc/apt/apt.conf.d/20auto-upgrades <<'EOF' || say "already on"
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
sys systemctl enable --now apt-daily.timer apt-daily-upgrade.timer

step "sysctl and IPv6"
put /etc/sysctl.d/60-demo.conf <<'EOF' && sys sysctl --system >/dev/null || true
# demo box: no ICMP redirects or source routing; swap only under pressure
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
vm.swappiness = 10
EOF
if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" = 1 ]; then say "IPv6 is off on this box; the firewall covers it anyway"
elif [ -n "$(ip -6 addr show scope global 2>/dev/null)" ] && [ -n "$(ip -6 route show default 2>/dev/null)" ]; then say "IPv6: global address and default route present"
else say "IPv6 is on but has no global address or default route; fine (Cloudflare reaches the box over IPv4)"; fi

step "deploy user $DEMO_USER"
id "$DEMO_USER" >/dev/null 2>&1 || { useradd --create-home --shell /bin/bash "$DEMO_USER"; say "created $DEMO_USER"; }
DH=$(getent passwd "$DEMO_USER" | cut -d: -f6)
if [ -s /root/.ssh/authorized_keys ]; then
  install -d -m 0700 -o "$DEMO_USER" -g "$DEMO_USER" "$DH/.ssh"
  put "$DH/.ssh/authorized_keys" 0600 < /root/.ssh/authorized_keys || say "authorized_keys already match root's"
  chown "$DEMO_USER:$DEMO_USER" "$DH/.ssh/authorized_keys"
else say "root has no authorized_keys; add the deploy user's key by hand"; fi

step "sshd: keys only"
ROOTLOGIN=prohibit-password
if [ "$NO_ROOT" = 1 ]; then
  [ -s "$DH/.ssh/authorized_keys" ] || die "--disable-root-login needs $DEMO_USER's authorized_keys first"
  ROOTLOGIN=no
fi
# 00- so these win: sshd keeps the first value it reads, and cloud images ship 50-cloud-init.conf.
# The new file is tested with sshd -t in place; if sshd rejects it, the previous file (or none) comes back.
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-demo.conf
SSHD_PREV=$(mktemp); SSHD_HAD=0
[ -f "$SSHD_DROPIN" ] && { cp -p "$SSHD_DROPIN" "$SSHD_PREV"; SSHD_HAD=1; }
put "$SSHD_DROPIN" <<EOF && SSHD_CHANGED=1 || SSHD_CHANGED=0
# written by deploy/server-setup.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
AuthenticationMethods publickey
PermitRootLogin $ROOTLOGIN
MaxAuthTries 3
X11Forwarding no
EOF
say "root login: $ROOTLOGIN"
if command -v sshd >/dev/null; then
  install -d -m 0755 /run/sshd
  if ! sshd -t; then
    if [ "$SSHD_HAD" = 1 ]; then install -m 0644 "$SSHD_PREV" "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi
    rm -f "$SSHD_PREV"
    die "sshd rejected the configuration (sshd -t); the previous $SSHD_DROPIN is back and sshd was not reloaded"
  fi
  if [ "$SSHD_CHANGED" = 1 ]; then sys systemctl try-reload-or-restart ssh.service; fi
else say "no sshd installed here (container?); nothing to test or reload"; fi
rm -f "$SSHD_PREV"

step "Docker Engine $DOCKER_MAJOR.x from download.docker.com ($CODENAME)"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc.new
FPR=$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc.new 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')
[ "$FPR" = 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ] || { rm -f /etc/apt/keyrings/docker.asc.new; die "Docker's signing key has an unexpected fingerprint ($FPR)"; }
mv -f /etc/apt/keyrings/docker.asc.new /etc/apt/keyrings/docker.asc; chmod a+r /etc/apt/keyrings/docker.asc
curl -fsS --max-time 20 -o /dev/null "https://download.docker.com/linux/ubuntu/dists/$CODENAME/Release" \
  || die "Docker's repo has no '$CODENAME'; re-run with DOCKER_CODENAME=noble (deploy/README.md, Docker repo fallback)"
put /etc/apt/sources.list.d/docker.list <<EOF || true
deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable
EOF
put /etc/apt/preferences.d/docker <<EOF || true
# keep Docker on major $DOCKER_MAJOR; raise DOCKER_MAJOR and re-run to move on
Package: docker-ce docker-ce-cli docker-ce-rootless-extras
Pin: version 5:$DOCKER_MAJOR.*
Pin-Priority: 1001
EOF
apt-get update -q >/dev/null
apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
say "$(docker --version 2>/dev/null || echo 'docker installed'), $(docker compose version 2>/dev/null || echo 'compose plugin installed')"
put /etc/docker/daemon.json <<'EOF' && sys systemctl restart docker || true
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sys systemctl enable --now docker.service containerd.service
usermod -aG docker "$DEMO_USER"
say "$DEMO_USER is in the docker group (root-equivalent on this box, by Docker's design)"

step "containers kept off metadata and link-local addresses (DOCKER-USER)"
put /usr/local/sbin/demo-docker-user 0755 <<'EOF' || true
#!/bin/sh
# Re-applied whenever Docker starts (demo-docker-user.service). Containers may not reach 169.254.0.0/16 (the cloud
# metadata service), fe80::/10 or AWS's IPv6 metadata address. The app refuses to start if it can (src/isolation.ts).
set -eu
add() { t=$1; shift; $t -C DOCKER-USER "$@" 2>/dev/null || $t -I DOCKER-USER "$@"; }
for t in iptables ip6tables; do $t -N DOCKER-USER 2>/dev/null || true; done
add iptables -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
add ip6tables -d fe80::/10 -j REJECT --reject-with icmp6-adm-prohibited
add ip6tables -d fd00:ec2::254/128 -j REJECT --reject-with icmp6-adm-prohibited
echo "DOCKER-USER: link-local and metadata addresses refused for containers"
EOF
put /etc/systemd/system/demo-docker-user.service <<'EOF' || true
[Unit]
Description=Keep containers off metadata and link-local addresses (DOCKER-USER)
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/demo-docker-user

[Install]
WantedBy=docker.service
EOF
sys systemctl daemon-reload
sys systemctl enable demo-docker-user.service
sys systemctl restart demo-docker-user.service

step "Caddy from its apt repo"
# Caddy's signing key ("Caddy Web Server <contact@caddyserver.com>"); the same fingerprint is on keyserver.ubuntu.com
CADDY_FPR=65760C51EDEA2017CEA2CA15155B6D79CA56EA34
curl -fsSL --proto '=https' https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/caddy-key.asc
FPR=$(gpg --show-keys --with-colons /tmp/caddy-key.asc 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')
[ "$FPR" = "$CADDY_FPR" ] || { rm -f /tmp/caddy-key.asc; die "Caddy's signing key has an unexpected fingerprint ($FPR)"; }
gpg --dearmor < /tmp/caddy-key.asc | put /usr/share/keyrings/caddy-stable-archive-keyring.gpg || true
rm -f /tmp/caddy-key.asc
curl -fsSL --proto '=https' https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | put /etc/apt/sources.list.d/caddy-stable.list || true
apt-get update -q >/dev/null
apt_install caddy
say "$(caddy version 2>/dev/null | cut -d' ' -f1 || echo 'caddy installed')"
install -d -m 0755 -o caddy -g caddy /var/log/caddy

step "firewall: 22 open, 80/443 from Cloudflare only, everything else closed"
# the firewall opens SSH on 22 only (cf-refresh.sh); on any other port this would lock you out
if command -v sshd >/dev/null; then
  SSH_PORTS=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -u | paste -sd' ' -)
  [ "$SSH_PORTS" = 22 ] || die "sshd listens on port(s) '${SSH_PORTS:-unknown}', but the firewall opens only 22; nothing loaded. Move sshd back to 22, or change 'tcp dport 22' in cf-refresh.sh first"
  say "sshd listens on 22 only"
fi
put /usr/local/sbin/demo-cf-refresh 0755 < "$HERE/cf-refresh.sh" || true
put /etc/systemd/system/demo-firewall.service <<'EOF' || true
[Unit]
Description=Demo host firewall (nftables table inet demo_host, saved Cloudflare ranges)
DefaultDependencies=no
Wants=network-pre.target
After=local-fs.target
Before=network-pre.target shutdown.target
Conflicts=shutdown.target
OnFailure=demo-firewall-alert.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=TMPDIR=/run
ExecStart=/usr/local/sbin/demo-cf-refresh --saved

[Install]
WantedBy=sysinit.target
EOF
put /etc/systemd/system/demo-firewall-alert.service <<'EOF' || true
[Unit]
Description=Alert: the demo host firewall did not load

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo "DEMO FIREWALL FAILED: table inet demo_host did not load at boot, so ports may be open. Check: systemctl status demo-firewall; then demo-cf-refresh" | systemd-cat -t demo-firewall -p emerg'
ExecStart=-/bin/sh -c 'echo "DEMO FIREWALL FAILED: table inet demo_host did not load at boot. Check: systemctl status demo-firewall" | wall'
EOF
put /etc/systemd/system/demo-cf-refresh.service <<'EOF' || true
[Unit]
Description=Refresh Cloudflare's ranges in the firewall and Caddy
Wants=network-online.target
After=network-online.target demo-firewall.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/demo-cf-refresh
EOF
put /etc/systemd/system/demo-cf-refresh.timer <<'EOF' || true
[Unit]
Description=Refresh Cloudflare's ranges daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  say "ufw is active; turning it off (this script's nftables table replaces it, and two firewalls would both have to agree)"
  sys ufw disable
fi
# the stock nftables.service loads /etc/nftables.conf, which starts with 'flush ruleset': that would wipe Docker's rules
# and this table. demo-firewall.service loads the table instead.
say "masking nftables.service (its 'flush ruleset' would wipe Docker's rules and this table)"
sys systemctl mask nftables.service
sys systemctl daemon-reload
if [ "$CHECK" = 1 ]; then
  /usr/local/sbin/demo-cf-refresh --check | sed -n '1p;$p'
  say "check, would run: demo-cf-refresh (fetch, validate, load table inet demo_host, write Caddy's trusted list)"
else
  /usr/local/sbin/demo-cf-refresh
fi
sys systemctl enable demo-firewall.service
sys systemctl enable --now demo-cf-refresh.timer

step "Caddy configuration"
put /etc/caddy/Caddyfile < "$HERE/Caddyfile" || say "Caddyfile unchanged"
if [ ! -f /etc/caddy/cloudflare-trusted.caddy ]; then
  # check mode never fetched for real: a validation-only stand-in so the Caddyfile can be checked
  [ "$CHECK" = 1 ] || die "no /etc/caddy/cloudflare-trusted.caddy (demo-cf-refresh did not write it)"
  /usr/local/sbin/demo-cf-refresh --check | awk '/^trusted_proxies/' > /etc/caddy/cloudflare-trusted.caddy
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || { caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true; die "Caddy rejected /etc/caddy/Caddyfile"; }
say "caddy validate: ok"
sys systemctl enable caddy.service
sys systemctl reload-or-restart caddy.service

step "done"
cat <<EOF
   Next (deploy/README.md): log in as $DEMO_USER (ssh $DEMO_USER@<box>), clone the repo, write .env, docker compose up.
   Checks: nft list table inet demo_host | iptables -S DOCKER-USER | systemctl list-timers demo-cf-refresh.timer
   Root login is '$ROOTLOGIN'.$([ "$NO_ROOT" = 0 ] && echo " After ssh $DEMO_USER@<box> works you may re-run with --disable-root-login.")
EOF
