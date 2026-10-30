// The box's only door to the internet: the /game/ page, a submit endpoint, the public feed, pot and rules, and the
// admin calls behind a token. No other route exists; every answer carries a strict content policy.
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnits } from 'viem'
import type { Agent } from './agent.ts'
import { decimalsFor, unitName, type Config } from './config.ts'
import {
  AdminGate, BodyRefused, clientIp, errorTag, FEED_PAGE, hardenServer, ipKey, Limits, MAX_TEXT_CHARS, parseAdminHide, parseAdminPause,
  parseFeedQuery, parseSubmit, publicAttempt, publicPot, publicRules, publicTrick, RateWindow, readJson, SharedRead, staticPath, vendorHandles,
} from './guard/index.ts'
import { rulesView, type SignedRules } from './rules.ts'
import { dayName, dayStart } from './spend.ts'
import type { Store } from './store.ts'
import type { Payer } from './wallet.ts'

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))

const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
}

const TRICKS = 10

export interface ServerDeps {
  cfg: Config; store: Store; agent: Agent; payer: Payer
  /** what the owner signed (src/rules.ts loadRules); none: the published rules from the settings */
  signed?: SignedRules | null
  now?: () => number; log?: (m: string) => void
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

// an oversized body is answered at once and the connection closed after the answer, so the unread rest goes nowhere
function refuseBody(res: ServerResponse, e: unknown) {
  const status = e instanceof BodyRefused ? e.status : 400
  send(res, status, { error: e instanceof BodyRefused ? e.message : 'bad request' }, status === 413 ? { connection: 'close' } : {})
}

export function makeServer(d: ServerDeps): Server {
  const { cfg, store, agent, payer } = d
  const limits = new Limits(cfg.limits, d.now)
  const reads = new RateWindow(600, 60_000, d.now)
  const reserved = vendorHandles(cfg.vendors)
  const admin = new AdminGate({ token: cfg.secrets.admin, localHeader: cfg.trustLocalHeader, now: d.now })
  const balance = new SharedRead(async () => formatUnits(await payer.balance(), decimalsFor(cfg.asset)), 15_000, d.now, e => d.log?.(`balance read failed: ${errorTag(e)}`))

  // the pot's counts and the tricks are read for everyone at most every few seconds, however many pages poll
  const stats = new SharedRead(async () => store.stats(), 4_000, d.now, e => d.log?.(`stats read failed: ${errorTag(e)}`))
  const tricks = new SharedRead(async () => ({ items: store.tricks(TRICKS).map(publicTrick) }), 4_000, d.now, e => d.log?.(`tricks read failed: ${errorTag(e)}`))
  const rules = publicRules(rulesView(cfg, d.signed ?? null))

  async function potView() {
    return publicPot({
      address: payer.address, balance: await balance.get(), unit: unitName(cfg.asset), network: cfg.network, chainId: cfg.chainId,
      explorerBase: cfg.explorer, paused: agent.paused(), budgetPaused: agent.pausedForBudget(), queued: store.queued(), stats: await stats.get(),
      vendors: cfg.vendors.map(v => ({ name: v.name, address: v.address })), limits: { textChars: MAX_TEXT_CHARS, feedPage: FEED_PAGE }, source: cfg.sourceUrl,
    })
  }

  // for the operator only: never on the public page
  function spendView() {
    const now = (d.now ?? Date.now)()
    return { day: dayName(now), today: store.spend(dayStart(now)), allTime: store.spend(), budgetUsd: cfg.spend.budgetUsd, budgetPer: 'UTC day',
      prices: { inPerMtok: cfg.spend.inPerMtok, outPerMtok: cfg.spend.outPerMtok }, paused: agent.pausedForBudget() }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://box')
    const ip = clientIp(req, cfg.trustLocalHeader, cfg.trustedProxies)
    const path = url.pathname

    if (req.method === 'GET' && path.startsWith('/api/admin/')) {
      const no = admin.check(req); if (no) return send(res, no.status, { error: no.error })
      if (path === '/api/admin/spend') return send(res, 200, spendView())
      return send(res, 404, { error: 'not found' })
    }

    if (req.method === 'GET' && path.startsWith('/api/')) {
      if (!reads.take(ipKey(ip))) return send(res, 429, { error: 'slow down' })
      if (path === '/api/pot') return send(res, 200, await potView())
      if (path === '/api/feed') {
        const q = parseFeedQuery(url.searchParams); if (!q.ok) return send(res, 400, { error: q.error })
        const { ids, limit, before } = q.value
        return send(res, 200, { items: (ids ? store.feedRows(ids) : store.feed(limit, before)).map(publicAttempt) })
      }
      if (path === '/api/tricks') return send(res, 200, (await tricks.get()) ?? { items: [] })
      if (path === '/api/rules') return send(res, 200, rules, { 'cache-control': 'public, max-age=300' })
      if (path === '/api/health') return send(res, 200, { ok: true })
      return send(res, 404, { error: 'not found' })
    }

    if (req.method === 'POST' && path === '/api/submit') {
      let b: unknown
      try { b = await readJson(req) } catch (e) { return refuseBody(res, e) }
      const p = parseSubmit(b, reserved); if (!p.ok) return send(res, 400, { error: p.error })
      const { handle, channel, text } = p.value
      if (agent.paused()) return send(res, 409, { error: 'the game is paused' })
      if (store.queued() >= cfg.limits.queueMax) return send(res, 503, { error: 'the inbox is full; try again in a minute' })
      const ok = limits.admit(handle, ip)
      if (!ok.ok) return send(res, 429, { error: ok.error }, { 'retry-after': String(Math.ceil(ok.retryAfterMs / 1000)) })
      const id = store.add({ source: 'player', handle, ipKey: ipKey(ip), channel, body: text })
      return send(res, 202, { id, queued: store.queued() })
    }

    if (req.method === 'POST' && path.startsWith('/api/admin/')) {
      const no = admin.check(req); if (no) return send(res, no.status, { error: no.error })
      let b: unknown
      try { b = await readJson(req) } catch (e) { return refuseBody(res, e) }
      if (path === '/api/admin/pause') {
        const p = parseAdminPause(b); if (!p.ok) return send(res, 400, { error: p.error })
        if (p.value.paused) agent.pause(p.value.why); else agent.resume()
        return send(res, 200, { paused: agent.paused() })
      }
      if (path === '/api/admin/hide') {
        const p = parseAdminHide(b); if (!p.ok) return send(res, 400, { error: p.error })
        return send(res, 200, { ok: store.hide(p.value.id, p.value.hidden) })
      }
      return send(res, 404, { error: 'not found' })
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/' || path === '/game') { res.writeHead(302, { ...HEADERS, location: '/game/' }); res.end(); return }
      const file = staticPath(path)
      if (file) {
        try {
          const body = readFileSync(join(PUBLIC, file.rel))
          // no-cache, not a short max-age: Cloudflare's browser TTL overrides a short max-age but respects no-cache,
          // so a deploy reaches players at once; the fonts never change
          const cache = file.rel.endsWith('.woff2') ? 'public, max-age=604800, immutable' : 'no-cache'
          res.writeHead(200, { ...HEADERS, 'content-type': file.type, 'cache-control': cache })
          res.end(req.method === 'HEAD' ? undefined : body)
          return
        } catch { return send(res, 404, { error: 'not found' }) }
      }
    }
    send(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    route(req, res).catch(e => { d.log?.(`request failed: ${errorTag(e)}`); if (!res.headersSent) send(res, 500, { error: 'server error' }) })
  })
  return hardenServer(server)
}
