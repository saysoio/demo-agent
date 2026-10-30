#!/usr/bin/env bash
# The box's host firewall, and the list of peers Caddy believes CF-Connecting-IP from. Both come from Cloudflare's
# published ranges (https://www.cloudflare.com/ips-v4 and /ips-v6), so the web ports answer Cloudflare only.
# Installed by server-setup.sh as /usr/local/sbin/demo-cf-refresh.
#
#   demo-cf-refresh            fetch, validate, apply (nftables table inet demo_host + Caddy's trusted list), save the list
#   demo-cf-refresh --saved    apply the saved list, no fetch (demo-firewall.service, at boot)
#   demo-cf-refresh --check    fetch, validate, print the ranges and the ruleset; change nothing (runs on a Mac too)
#
# A failed fetch, or a list that does not look like Cloudflare's, changes nothing: the rules in force stay.
# The table:
#   input   policy drop. Loopback, replies, ICMP and ICMPv6 (IPv6 needs neighbour discovery), DHCP, SSH on 22, and
#           80/443 from Cloudflare only. Not SSH from containers. Containers reaching the host (172.30.0.1) fall to the drop, which is what the
#           app's isolation check wants. 8787 is published on 127.0.0.1 only and never opened here.
#   forward containers may not reach link-local addresses (169.254.0.0/16: the cloud metadata service; fe80::/10) or
#           AWS's IPv6 metadata address. DOCKER-USER blocks the same (server-setup.sh); this is the second lock.
set -euo pipefail

STATE=${DEMO_FW_STATE:-/etc/demo-firewall}
CADDY_SNIPPET=${DEMO_CADDY_SNIPPET:-/etc/caddy/cloudflare-trusted.caddy}
CADDYFILE=${DEMO_CADDYFILE:-/etc/caddy/Caddyfile}
MODE=apply
case "${1:-}" in
  '') ;;
  --saved) MODE=saved ;;
  --check) MODE=check ;;
  *) echo "usage: demo-cf-refresh [--saved|--check]" >&2; exit 2 ;;
esac

say() { echo "cf-refresh: $*"; }
die() { echo "cf-refresh: $*; nothing changed" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Reads a list on stdin; prints it back sorted, one canonical range per line, or fails. A range must be a network
# address of its family (no host bits), no wider than /12 (IPv4) or /28 (IPv6), so a cut-off 104.16.0.0/13 can never
# become 104.16.0.0/1. Between 5 and 100 ranges for IPv4, 2 and 100 for IPv6.
validate() {
  python3 -I -c '
import ipaddress, sys
fam = int(sys.argv[1])
widest, least = (12, 5) if fam == 4 else (28, 2)
out = set()
for raw in sys.stdin.read().splitlines():
    line = raw.strip()
    if not line:
        continue
    try:
        n = ipaddress.ip_network(line, strict=True)
    except ValueError:
        sys.exit(f"not a network: {line[:60]!r}")
    if n.version != fam:
        sys.exit(f"not IPv{fam}: {line}")
    if n.prefixlen < widest:
        sys.exit(f"wider than /{widest}: {line}")
    out.add(n)
if not least <= len(out) <= 100:
    sys.exit(f"{len(out)} IPv{fam} ranges; expected {least} to 100")
print("\n".join(str(n) for n in sorted(out)))
' "$1"
}

fetch() {
  curl -fsS --proto '=https' --tlsv1.2 --max-time 15 --retry 2 --retry-delay 3 "https://www.cloudflare.com/ips-v$1"
}

render_nft() {
  # an empty list renders an empty set (web ports closed), never a syntax error
  local v4 v6 e4='' e6=''
  v4=$(paste -sd, "$1" | sed 's/,/, /g'); v6=$(paste -sd, "$2" | sed 's/,/, /g')
  if [ -n "$v4" ]; then e4="elements = { $v4 }"; fi
  if [ -n "$v6" ]; then e6="elements = { $v6 }"; fi
  cat <<EOF
table inet demo_host
delete table inet demo_host
table inet demo_host {
  set cloudflare4 {
    type ipv4_addr; flags interval
    $e4
  }
  set cloudflare6 {
    type ipv6_addr; flags interval
    $e6
  }
  chain input {
    type filter hook input priority filter; policy drop;
    iif "lo" accept
    meta l4proto ipv6-icmp accept
    ct state established,related accept
    ct state invalid drop
    meta l4proto icmp accept
    udp sport 67 udp dport 68 accept
    ip6 saddr fe80::/10 udp sport 547 udp dport 546 accept
    iifname "docker0" tcp dport 22 drop
    iifname "br-*" tcp dport 22 drop
    tcp dport 22 accept
    tcp dport { 80, 443 } ip saddr @cloudflare4 accept
    tcp dport { 80, 443 } ip6 saddr @cloudflare6 accept
    counter
  }
  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    ip daddr 169.254.0.0/16 counter reject with icmpx type admin-prohibited
    ip6 daddr { fe80::/10, fd00:ec2::254 } counter reject with icmpx type admin-prohibited
  }
}
EOF
}

render_caddy() {
  echo "# Written by demo-cf-refresh from Cloudflare's published ranges; do not edit (the next refresh replaces it)."
  echo "trusted_proxies static $(cat "$1" "$2" | paste -sd' ' -)"
}

if [ "$MODE" = saved ]; then
  # at boot: an unreadable saved list still loads the table, with the web ports closed, never a table-less box
  { [ -s "$STATE/cloudflare-v4.txt" ] && validate 4 < "$STATE/cloudflare-v4.txt" > "$TMP/v4"; } || { say "no sound saved IPv4 list; web ports stay closed"; : > "$TMP/v4"; }
  { [ -s "$STATE/cloudflare-v6.txt" ] && validate 6 < "$STATE/cloudflare-v6.txt" > "$TMP/v6"; } || { say "no sound saved IPv6 list; web ports stay closed"; : > "$TMP/v6"; }
else
  for fam in 4 6; do
    fetch "$fam" > "$TMP/raw$fam" || die "could not fetch https://www.cloudflare.com/ips-v$fam"
    validate "$fam" < "$TMP/raw$fam" > "$TMP/v$fam" || die "the IPv$fam list does not look like Cloudflare's ranges"
  done
fi
say "$(grep -c . "$TMP/v4" || true) IPv4 and $(grep -c . "$TMP/v6" || true) IPv6 ranges"
render_nft "$TMP/v4" "$TMP/v6" > "$TMP/host.nft"
render_caddy "$TMP/v4" "$TMP/v6" > "$TMP/trusted.caddy"

if [ "$MODE" = check ]; then
  echo "--- IPv4"; cat "$TMP/v4"; echo "--- IPv6"; cat "$TMP/v6"
  echo "--- nftables ruleset that would be applied"; cat "$TMP/host.nft"
  echo "--- Caddy snippet"; cat "$TMP/trusted.caddy"
  if command -v nft >/dev/null && nft -c -f "$TMP/host.nft" 2>/dev/null; then say "nft -c: the ruleset parses"
  else say "nft -c skipped or not permitted here (needs nftables and CAP_NET_ADMIN)"; fi
  exit 0
fi

[ "$(id -u)" = 0 ] || die "run as root"
exec 9> /run/demo-cf-refresh.lock
flock -w 60 9 || die "another refresh is running"

nft -c -f "$TMP/host.nft" || die "nft refused the ruleset"
nft -f "$TMP/host.nft"
say "firewall loaded (table inet demo_host)"
[ "$MODE" = saved ] && exit 0

install -d -m 0755 "$STATE"
install -m 0644 "$TMP/v4" "$STATE/cloudflare-v4.txt.new" && mv -f "$STATE/cloudflare-v4.txt.new" "$STATE/cloudflare-v4.txt"
install -m 0644 "$TMP/v6" "$STATE/cloudflare-v6.txt.new" && mv -f "$STATE/cloudflare-v6.txt.new" "$STATE/cloudflare-v6.txt"

# Caddy: only a configuration it accepts stays; otherwise the previous snippet comes back
if [ -d "$(dirname "$CADDY_SNIPPET")" ] && command -v caddy >/dev/null; then
  if cmp -s "$TMP/trusted.caddy" "$CADDY_SNIPPET"; then say "Caddy's trusted list is unchanged"; exit 0; fi
  [ -f "$CADDY_SNIPPET" ] && cp -p "$CADDY_SNIPPET" "$TMP/previous.caddy"
  install -m 0644 "$TMP/trusted.caddy" "$CADDY_SNIPPET"
  if [ -f "$CADDYFILE" ] && ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    if [ -f "$TMP/previous.caddy" ]; then install -m 0644 "$TMP/previous.caddy" "$CADDY_SNIPPET"; fi
    echo "cf-refresh: the firewall has the new ranges, but Caddy rejected the new trusted list (caddy validate --config $CADDYFILE); Caddy keeps the previous one" >&2
    exit 1
  fi
  if systemctl is-active --quiet caddy 2>/dev/null; then systemctl reload caddy && say "Caddy reloaded with the new trusted list"; fi
fi
