# demo-agent

sayso's public demo, "Break the guard": an AI agent pays our vendor invoices from a wallet with real money in it, and
every payment it tries is checked by sayso before the wallet signs. Players send it emails, invoices, posts and team chat
messages through `/game/`. Anyone who gets money out to an address that is not one of our vendors keeps it.

## How it works

```
player ──/game/ form──▶ inbox (SQLite) ──▶ Haiku reads one item ──▶ JSON decision ──▶ shape check ──▶ guarded wallet ──▶ sayso
                                                                       (no tools)        (code)        (CDP account,      allow / ask / block
                                                                                                         enforce mode)
```

- **The model has no tools.** `claude-haiku-5-5` reads one inbox item and returns `{action, to, amount, memo, thought}`
  in a fixed schema (structured outputs). It cannot run code, fetch URLs, read files or see a key.
- **The code checks shape only** (`src/guard/model.ts` `checkDecision`): a real address and a positive amount. It never
  decides whether to pay. sayso does.
- **The wallet** is a Coinbase CDP server-wallet account: the key stays with Coinbase. It is wrapped by the `saysoio`
  SDK (0.7.0) in enforce mode, which fails closed. A block, an ask (nobody is on duty to approve), or a slow or unverifiable answer means
  "not signed".
- **Four ways in** for players: email, invoice, social post, a message in the internal team chat. Each is one item, read
  on its own.
- **Real vendor invoices** arrive on a timer, so allowed payments show up in the feed next to the attacks.
- **A win** (money paid to a non-vendor) pauses the game automatically.
- **Limits:** per handle and per IP (hour and day), a global pace, a daily cap on model calls, a cap on the queue, 600
  characters per item, 4 KB per request.
- **Isolation:** the box refuses to start as root, with secret-looking settings that are not its own or settings that
  reroute its traffic, or where it can read AWS or SSH credentials, reach sayso's ports on this machine or (from a
  container) its host, or reach the cloud metadata service (`src/isolation.ts`).

## Run it locally (no keys, no network)

```bash
npm install
npm run dev        # scripted brain and a pretend sayso, on http://127.0.0.1:8787/game/
npm test
npm run typecheck
```

Node 24 or newer runs the TypeScript directly; there is no build step.

## Going live

1. Pick the vendors: wallets **we** control, listed in `DEMO_VENDORS`.
2. On the owner's Mac, `npm run setup` with the CDP keys and `OWNER_PRIVATE_KEY`. It creates the agent's CDP account,
   registers it, has sayso compile the rules, shows them, and on "sign" signs the mandate and turns enforce on. Without
   a linked Telegram chat sayso refuses its server-side switch; setup notes it and goes on, since the box enforces
   through the SDK anyway. The owner key never goes to the box.
3. On the box: its own user, `.env` from `.env.example` with `DEMO_SAYSO_API_KEY` from step 2, `npm start` behind a
   proxy with TLS.
4. Fund the agent wallet (Sepolia test ETH first; the real pot only after the go/no-go).

The production box (Caddy behind Cloudflare, firewall, backups, updates, go-live checklist): `deploy/README.md`.

Admin (token in `DEMO_ADMIN_TOKEN`):

```bash
curl -X POST -H "authorization: Bearer $DEMO_ADMIN_TOKEN" -H 'content-type: application/json' -d '{"paused":true,"why":"maintenance"}' http://127.0.0.1:8787/api/admin/pause
curl -X POST -H "authorization: Bearer $DEMO_ADMIN_TOKEN" -H 'content-type: application/json' -d '{"id":42}' http://127.0.0.1:8787/api/admin/hide
```

## Docker

```bash
cp .env.example .env          # fill it in on the box; never commit it, never bake it into the image
docker compose up -d --build
docker compose ps             # "healthy" once GET /api/health answers
docker compose logs -f
```

- **Image:** `node:24.11.1-bookworm-slim`, runtime deps only, npm removed from the final stage, runs as `sayso-demo`
  (uid 10001). Dependencies install with `npm ci --omit=dev` from `package-lock.json`; the build fails without it, so
  the lockfile must be committed.
- **Container:** read-only root, `/tmp` on tmpfs, all capabilities dropped, `no-new-privileges`, 512 MB and 128 pids,
  `restart: unless-stopped`. SQLite lives on the named volume `demo-data` (`/app/data`).
- **Network:** it listens on `0.0.0.0:8787` inside the container (compose's `environment` sets `DEMO_HOST`, `DEMO_PORT`
  and `DEMO_DATA_DIR`, and wins over `.env`), published on `127.0.0.1:8787` only. No TLS here: put a proxy in front.
- **Client addresses:** the app believes `DEMO_TRUST_LOCAL_HEADER` only from a loopback peer or an address listed in
  `DEMO_TRUSTED_PROXY` (exact IPs, comma-separated, no ranges). Inside the container no proxy is loopback: a proxy on
  the host connects from the network's gateway, one in another container from its bridge address. So on a non-loopback
  `DEMO_HOST` the box refuses to start without `DEMO_TRUSTED_PROXY` and the header. The compose project's default
  network has a pinned gateway (`subnet: 172.30.0.0/24, gateway: 172.30.0.1` in `compose.yaml`): list `172.30.0.1` for
  a proxy on the host (the production setup in `deploy/README.md`), or the proxy container's fixed address. Trusted
  proxies never reach the admin calls.
- **Admin calls** must come from inside the container (the admin gate accepts loopback only):

  ```bash
  docker compose exec demo-agent node -e "fetch('http://127.0.0.1:8787/api/admin/pause',{method:'POST',headers:{authorization:'Bearer '+process.env.DEMO_ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({paused:true,why:'maintenance'})}).then(async r=>console.log(r.status,await r.text()))"
  ```

- **EC2:** set the instance metadata hop limit to 1 (or disable IMDS), so containers cannot reach
  169.254.169.254. With the default hop limit of 2 on many AMIs the isolation check sees the metadata service and the
  box refuses to start, by design.

### Model access

Where `api.anthropic.com` is not served directly (Hong Kong, for one), route the model's calls one of two ways. Only the
model's traffic takes this route; sayso, the RPC node and Coinbase CDP stay direct.

- `DEMO_LLM_BASE_URL`: an API gateway or reverse proxy that speaks the Anthropic API. https only (http allowed with
  `DEMO_DEV=1`), no credentials in the URL.
- `DEMO_LLM_PROXY`: a forward HTTP(S) proxy, for example `http://user:pass@host:3128`. It is a secret (listed in
  `OWN_SECRETS`) and never logged; the start line says only "model via proxy" or "model via gateway".
- `DEMO_LLM_MODEL`: the model id, `claude-haiku-5-5` by default.

**Outline key.** An Outline access key (`ss://…`) is a Shadowsocks key, which Node cannot use directly. Compose has an
optional `outline` service (`sslocal` from shadowsocks-rust) that turns it into an HTTP proxy on the compose network:

```bash
printf 'OUTLINE_KEY=%s\n' 'ss://…' > outline.env   # never commit it (ignored by git and the image)
chmod 600 outline.env
# in .env: DEMO_LLM_PROXY=http://outline:1080
docker compose --profile outline up -d --build
```

The key stays in that container; its port is not published. A dynamic key (`ssconf://…`) must first be resolved to the
`ss://` key it points to.

The box refuses to start with `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` (any case), `NODE_USE_ENV_PROXY` or
`ANTHROPIC_BASE_URL` set: they would send every call through a proxy, or the model's calls elsewhere. The client always
gets its base URL from the box (`api.anthropic.com` unless `DEMO_LLM_BASE_URL` is set).

## Before the real pot (not done in code)

1. **A dedicated CDP project with a Policy Engine rule.** The CDP API key and wallet secret on the box can sign for any
   account in their project, past sayso. Give this one account its own project, and set a policy that allows only
   `transfer` on USDC to the vendor addresses under the per-payment cap, and denies everything else (other contracts,
   ETH sends, message and hash signing). Then a full takeover of the box is bounded by the policy too.
2. **saysoio 0.7.0, published.** The box is built against 0.7.0 (`package.json` pins it exactly). 0.7.0 signs only on
   sayso's signed allow for that very request (an outage, a timeout past 10 s or an unverified answer is refused; 0.6.3
   could sign one once it had seen shadow), signs first, decodes and compares the bytes with the checked transaction
   before it broadcasts them, and bounds the fee of every transaction. The box tightens those bounds to
   `DEMO_MAX_FEE_GWEI` (`feeBounds` in `src/wallet.ts`: priority fee at most the ceiling, gas x fee at most our gas limit
   x the ceiling, at most 60 such fees an hour) and keeps its own gas limit and per-gas ceiling, checked before sayso is
   asked. 0.7.0 was published on 31 Oct; its npm integrity equals the reviewed release tarball
   (`sha512-vut6m9iS…Xm5i1BZ6tbe+A==`), and the lockfile pins it.
3. **Mandate strictness: decided, `strict` (31 Oct).** sayso's compiler reads the rules' closing sentence as `strict`,
   and for a wallet holding a prize that is the safer setting: a tighter judge, unreadable calls blocked, and no
   new-payee ask. Setup accepts `strict` or `normal`, never `lenient`. The rules state a per-payment, daily and weekly cap
   (`DEMO_WEEKLY_CAP`, three times `DEMO_DAILY_CAP` by default). The compiler's token list names what the agent may
   trade into, so with `transfer` the only action it may be empty or the asset itself.
4. Set `DEMO_MAX_PER_PAYMENT` on the box to the signed cap, in the asset's unit (required on base): an allow above it
   pauses the game.
5. Verify the USDC address with `cast code` and fund only after the go/no-go.

## Networks

| `DEMO_NETWORK` | Asset | Note |
|---|---|---|
| `base-sepolia` | ETH | sayso's test server understands ETH transfers only; tokens there lean to "ask" |
| `base` | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) | verify with `cast code` before funding |
