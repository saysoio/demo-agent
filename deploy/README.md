# Production runbook: game.saysoio.com

The box runs the existing compose service behind Caddy on the host, behind Cloudflare's proxy. Run the steps in order.
Secrets are typed or copied by you, on your Mac or in your own SSH session. Never paste one into a chat.

```
player ──https──▶ Cloudflare (proxy, rate limit) ──https──▶ Caddy :443 on the box ──http──▶ 127.0.0.1:8787 ──▶ container
                                                  only Cloudflare's ranges reach 80/443      (172.30.0.1 → 172.30.0.x)
```

| File | What it is |
|---|---|
| `server-setup.sh` | one-time, re-runnable box setup as root (swap, upgrades, user, sshd, Docker, Caddy, firewall) |
| `cf-refresh.sh` | installed as `/usr/local/sbin/demo-cf-refresh`: Cloudflare's ranges into the firewall and Caddy, daily |
| `Caddyfile` | installed as `/etc/caddy/Caddyfile` |

## 1. The box

It exists: Timeweb Cloud, Amsterdam, `72.56.29.190`, Ubuntu 26.04 LTS, 1 vCPU, 889 MiB RAM, 14 GB disk. Root logs in
with `~/.ssh/demo_vps` (SSH alias `demo-vps`). Add a second alias for the deploy user to `~/.ssh/config` on the Mac:

```
Host demo-vps-demo
  HostName 72.56.29.190
  User demo
  IdentityFile ~/.ssh/demo_vps
  IdentitiesOnly yes
```

Something listens on `0.0.0.0:10050`: Timeweb's Zabbix monitoring agent. The firewall closes it (only 22 is open to
everyone). If you want the provider's monitoring graphs back, ask Timeweb support for their monitoring addresses and
open 10050 to those only; otherwise leave it closed or stop it (`systemctl disable --now zabbix-agent`).

## 2. Cloudflare (dashboard, zone saysoio.com)

1. **DNS → Add record:** type `A`, name `game`, IPv4 `72.56.29.190`, Proxy status **Proxied** (orange cloud). No AAAA
   record is needed: Cloudflare serves visitors over IPv6 and reaches the box over IPv4.
2. **SSL/TLS → Overview:** the zone is already **Full (strict)**. Keep it.
3. **SSL/TLS → Edge Certificates → Always Use HTTPS: off** (it is off for the zone if sayso's `api` and `sepolia`
   renew their Let's Encrypt certificates the same way). Caddy proves the name over plain HTTP through Cloudflare
   (HTTP-01) and redirects everything else to HTTPS itself. With that switch on, the first certificate cannot be issued.
4. **Security → WAF → Rate limiting rules → Create rule:** name `game submit`; when URI Path equals `/api/submit` and
   Request Method equals `POST`; same characteristics: IP; 10 requests per 10 seconds; action Block for 10 seconds
   (the free plan's limits). The app's own limits (30 per IP an hour) still apply behind it.

**Alternative, a Cloudflare Origin Certificate** (no Let's Encrypt, no dependency on "Always Use HTTPS"): SSL/TLS →
Origin Server → Create Certificate for `game.saysoio.com`, 15 years. On the box as root, save the two parts as
`/etc/caddy/origin/cert.pem` and `/etc/caddy/origin/key.pem` (`chown -R root:caddy /etc/caddy/origin`,
`chmod 640` both files), add `tls /etc/caddy/origin/cert.pem /etc/caddy/origin/key.pem` inside the `game.saysoio.com`
block of `/etc/caddy/Caddyfile`, then `systemctl reload caddy`. Browsers never see that certificate; only Cloudflare does.

## 3. Run the setup (Mac → box, as root)

The `deploy-kit` branch must be on GitHub first (you push it; the box clones it in step 4).

```bash
cd ~/Code/demo-agent
scp -r deploy demo-vps:/root/demo-deploy
ssh demo-vps 'bash /root/demo-deploy/server-setup.sh'
```

It prints every step and asks nothing. Re-running it is safe. Docker's apt repo has Ubuntu 26.04 (`resolute`); if a
later release is missing there, re-run with `DOCKER_CODENAME=noble` (24.04's packages run on newer Ubuntu), or as a last
resort install Ubuntu's own `docker.io` and `docker-compose-v2` instead.

Check from the Mac:

```bash
ssh demo-vps-demo true && echo "demo user works"
ssh demo-vps 'nft list table inet demo_host | head -20; iptables -S DOCKER-USER; systemctl list-timers demo-cf-refresh.timer; swapon --show'
curl -m 5 -sk https://72.56.29.190/ ; echo "exit $? (28, a timeout, is right: only Cloudflare reaches 443)"
```

Root keeps key-only login, because the `demo` user has no sudo and root does the system upkeep (Caddy, firewall,
upgrades). To turn root login off anyway: `ssh demo-vps 'bash /root/demo-deploy/server-setup.sh --disable-root-login'`,
and only after `ssh demo-vps-demo` works.

## 4. Clone the repo (as demo)

If the repo stays **private**, use a read-only deploy key (a key that can read this one repo and nothing else):

```bash
ssh demo-vps-demo
ssh-keygen -t ed25519 -N '' -C demo-agent-deploy -f ~/.ssh/demo-agent-deploy
cat ~/.ssh/demo-agent-deploy.pub
```

GitHub → saysoio/demo-agent → Settings → Deploy keys → Add deploy key: paste the `.pub` line, leave "Allow write
access" unticked. Then, still on the box:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/demo-agent-deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
git clone git@github.com:saysoio/demo-agent.git ~/demo-agent
cd ~/demo-agent && git checkout deploy-kit   # until it is merged into main
```

If the repo is **public**: `git clone https://github.com/saysoio/demo-agent.git ~/demo-agent`.

## 5. Owner setup (on your Mac, never on the box)

1. In `~/Code/demo-agent`, create `.env.setup` (git ignores it), `chmod 600 .env.setup`, and fill it yourself: the CDP
   keys of the dedicated CDP project, `OWNER_PRIVATE_KEY`, `DEMO_NETWORK`, `DEMO_ASSET`, `DEMO_VENDORS`,
   `DEMO_MAX_PER_PAYMENT`, `DEMO_DAILY_CAP` (see the end of `.env.example`).
2. `npm run setup`. Read the compiled rules, type "sign". It writes the agent's sayso API key to `data/sayso-api-key`.
3. Copy that key to the box (step 6 moves it into `.env` and deletes the copy):

   ```bash
   scp data/sayso-api-key demo-vps-demo:sayso-api-key
   ```

## 6. The box's `.env` (as demo, typed by you)

```bash
ssh demo-vps-demo
cd ~/demo-agent
cp .env.example .env && chmod 600 .env
( umask 077
  grep -vE '^(DEMO_SAYSO_API_KEY|DEMO_ADMIN_TOKEN)=' .env > .env.new
  printf 'DEMO_SAYSO_API_KEY=%s\n' "$(tr -d '\n' < ~/sayso-api-key)" >> .env.new
  printf 'DEMO_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env.new
  mv .env.new .env )
shred -u ~/sayso-api-key
nano .env
```

In `nano`, set:

| Setting | Value |
|---|---|
| `DEMO_NETWORK` / `DEMO_ASSET` | `base-sepolia` / `eth` for the rehearsal |
| `DEMO_VENDORS` | the real vendor book (wallets we control), the same as in `.env.setup` |
| `ANTHROPIC_API_KEY` | the workspace key with a spend cap (go-live list) |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | the dedicated CDP project's keys |
| `DEMO_TRUST_LOCAL_HEADER` | `cf-connecting-ip` (uncomment the line) |
| `DEMO_TRUSTED_PROXY` | `172.30.0.1` (uncomment the line: Caddy on the host reaches the container from the network's gateway) |
| `DEMO_MAX_PER_PAYMENT` | the signed per-payment cap |
| `DEMO_LLM_BASE_URL`, `DEMO_LLM_PROXY` | leave empty: Amsterdam reaches api.anthropic.com directly |

`DEMO_HOST`, `DEMO_PORT` and `DEMO_DATA_DIR` in `.env` do not matter (compose sets them). Delete the setup-only lines
at the bottom if you uncommented any: the box refuses to start with `OWNER_PRIVATE_KEY` or other secret-looking names
that are not its own.

## 7. Start

```bash
cd ~/demo-agent
docker compose up -d --build
docker compose ps          # "healthy" after about 30 s
docker compose logs --tail 50
```

The start line reads `demo-agent on http://0.0.0.0:8787/game/ (base-sepolia, eth, wallet 0x…)`. A
`refusing to start:` list means the isolation check found something (for example the metadata service or a host port);
fix that, do not work around it.

**The box is small.** Building on it takes a few minutes (`npm ci` uses the 2 GB swap). Instead you can build on the
Mac and ship the image (check the box's architecture first: `ssh demo-vps dpkg --print-architecture`, usually amd64):

```bash
docker buildx build --platform linux/amd64 -t demo-agent:local --load .
docker save demo-agent:local | gzip | ssh demo-vps-demo 'gunzip | docker load'
ssh demo-vps-demo 'cd ~/demo-agent && docker compose up -d --no-build'
```

**Docker Hub is slow** (from Hong Kong, often): pull the Node base image from AWS's public mirror and give it the name
the Dockerfile asks for. Same image, so the build uses it without touching Docker Hub:

```bash
docker pull public.ecr.aws/docker/library/node:24.11.1-bookworm-slim
docker tag public.ecr.aws/docker/library/node:24.11.1-bookworm-slim node:24.11.1-bookworm-slim
```

The Dockerfile's `# syntax=docker/dockerfile:1` line still fetches BuildKit's frontend from Docker Hub once; after the
first success it is cached.

## 8. Health and smoke checks

```bash
curl -s https://game.saysoio.com/api/health                            # {"ok":true}
curl -sI https://game.saysoio.com/api/health | grep -iE 'server|strict-transport|content-security'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://game.saysoio.com/api/admin/pause   # 404: admin is never routed
```

Then open `https://game.saysoio.com/game/` in a browser, send one email as a player, and watch it appear in the feed and
in `docker compose logs -f`.

## 9. Logs

| What | Where |
|---|---|
| the app | `docker compose logs -f --tail 100` (as demo, in `~/demo-agent`); rotated at 3 x 10 MB |
| requests | `tail -f /var/log/caddy/game.access.log` (as root; JSON, the visitor's address in `client_ip`, no query strings) |
| Caddy itself, certificates | `journalctl -u caddy -n 100` |
| firewall refresh | `journalctl -u demo-cf-refresh -n 20` and `systemctl list-timers demo-cf-refresh.timer` |

## 10. Pause, resume, hide (from inside the container)

The admin calls accept only a loopback peer and read the token from the container's own environment, so you never type it:

```bash
cd ~/demo-agent
admin() { docker compose exec -T demo-agent node -e "fetch('http://127.0.0.1:8787/api/admin/'+process.argv[1],{method:'POST',headers:{authorization:'Bearer '+process.env.DEMO_ADMIN_TOKEN,'content-type':'application/json'},body:process.argv[2]}).then(async r=>console.log(r.status,await r.text()))" "$1" "$2"; }
admin pause '{"paused":true,"why":"maintenance"}'
admin pause '{"paused":false}'
admin hide '{"id":42}'
```

## 11. Update

```bash
cd ~/demo-agent
admin pause '{"paused":true,"why":"update"}'        # optional; admin() is defined in step 10
docker tag demo-agent:local demo-agent:previous      # the rollback point
git pull --ff-only
docker compose up -d --build
docker compose ps && docker compose logs --tail 20
docker image prune -f                                # the disk is 14 GB
```

The pause is stored in SQLite and survives the restart: resume with `admin pause '{"paused":false}'` when the update looks right.

## 12. Backup of the SQLite data

A consistent copy while the app runs (SQLite's `VACUUM INTO`), then off the box:

```bash
cd ~/demo-agent && mkdir -p ~/backups && F=demo-$(date +%F-%H%M).db
docker compose exec -T demo-agent node -e "new (require('node:sqlite').DatabaseSync)('/app/data/demo.db').exec(\"VACUUM INTO '/app/data/$F'\")"
docker compose cp demo-agent:/app/data/$F ~/backups/$F && docker compose exec -T demo-agent rm /app/data/$F
# on the Mac
scp demo-vps-demo:backups/$F ~/Backups/demo-agent/
```

The file holds player handles and texts: keep it private.

**Restore:** `docker compose down` (never `-v`, which deletes the volume), then

```bash
docker run --rm --user 10001:10001 -v demo-agent_demo-data:/data -v ~/backups:/b:ro --entrypoint sh demo-agent:local \
  -c 'rm -f /data/demo.db-wal /data/demo.db-shm && cp /b/FILE.db /data/demo.db'
docker compose up -d
```

## 13. Rollback

Fast, to the image from before the last update: `docker tag demo-agent:previous demo-agent:local && docker compose up -d --no-build`.
To a known commit: `git checkout <sha> && docker compose up -d --build`; back with `git checkout <branch>`. If the data
went wrong too, restore the last backup (step 12).

## 14. Go-live checklist (real pot)

Each line is done, by the person named, before the next.

1. **Sepolia rehearsal:** the box on `base-sepolia`, 20 or more distinct attacks through `/game/` (all four channels),
   vendor invoices paid, no payment to a non-vendor, the win path tested (pause on a non-vendor payment).
2. **Anthropic:** a workspace of its own for the demo, its own API key, a monthly spend cap set in the console.
3. **CDP:** a dedicated CDP project holding only this account, with the Policy Engine rule from the main README
   ("Before the real pot", 1): USDC `transfer` to the vendor addresses under the per-payment cap, everything else denied.
4. **Alex's decision:** the written go/no-go on real funds (amount and date) from Alex.
5. **Switch:** on the Mac, `npm run setup` again with `DEMO_NETWORK=base`, `DEMO_ASSET=usdc`, the invite and the real
   caps; copy the new `sayso-api-key` over (step 5). On the box set `DEMO_NETWORK=base`, `DEMO_ASSET=usdc`,
   `DEMO_MAX_PER_PAYMENT` to the signed cap, then `docker compose up -d`. Verify the USDC address with `cast code`.
6. **Fund:** the founder sends the pot to the agent wallet shown on `/game/`. Nobody else moves real funds.
