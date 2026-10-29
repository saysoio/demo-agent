// Limits in front of the model. Adapted from sayso's Season 0 game (apps/game/src/limits.ts): per handle, per IP (hour
// and day), a global pace and a daily cap on model calls (the bill); plus the caps on connections and shared reads.
import { isIP } from 'node:net'
import type { Server } from 'node:http'
import type { Config } from '../config.ts'

const HOUR = 3600_000, DAY = 24 * HOUR
export const MAX_CONNECTIONS = 256

export class WindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly maxKeys: number
  constructor(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = 50_000) {
    this.limit = limit; this.windowMs = windowMs; this.now = now; this.maxKeys = maxKeys
  }
  private live(key: string): number[] {
    const t = this.now(), l = (this.hits.get(key) ?? []).filter(h => h > t - this.windowMs)
    if (l.length) this.hits.set(key, l); else this.hits.delete(key)
    return l
  }
  check(key: string): { ok: boolean; retryAfterMs: number } {
    const l = this.live(key)
    return l.length < this.limit ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: l[0] + this.windowMs - this.now() }
  }
  hit(key: string) {
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) for (const k of [...this.hits.keys()]) this.live(k)
    const l = this.live(key); l.push(this.now()); this.hits.set(key, l)
  }
}

/** A plain counter per key and fixed window, for the public reads: one number per key, and past `maxKeys` expired keys
 *  are swept, then the oldest dropped (memory wins over exactness under a flood). */
export class RateWindow {
  private readonly counts = new Map<string, { start: number; n: number }>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly maxKeys: number
  constructor(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = 50_000) {
    this.limit = limit; this.windowMs = windowMs; this.now = now; this.maxKeys = maxKeys
  }
  take(key: string): boolean {
    const t = this.now()
    let c = this.counts.get(key)
    if (c && t - c.start >= this.windowMs) { this.counts.delete(key); c = undefined }
    if (!c) {
      if (this.counts.size >= this.maxKeys) {
        for (const [k, v] of this.counts) if (t - v.start >= this.windowMs) this.counts.delete(k)
        while (this.counts.size >= this.maxKeys) this.counts.delete(this.counts.keys().next().value!)
      }
      c = { start: t, n: 0 }; this.counts.set(key, c)
    }
    if (c.n >= this.limit) return false
    c.n++
    return true
  }
}

/** One upstream read shared by every caller: a fresh value is reused, and while it is stale a single read is in flight
 *  for all of them. A failed read keeps the last value (null before the first success). */
export class SharedRead<T> {
  private value: T | null = null
  private at = -Infinity
  private pending: Promise<T | null> | null = null
  private readonly read: () => Promise<T>
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly onError?: (e: unknown) => void
  constructor(read: () => Promise<T>, maxAgeMs: number, now: () => number = Date.now, onError?: (e: unknown) => void) {
    this.read = read; this.maxAgeMs = maxAgeMs; this.now = now; this.onError = onError
  }
  get(): Promise<T | null> {
    if (this.now() - this.at <= this.maxAgeMs) return Promise.resolve(this.value)
    this.pending ??= this.read()
      .then(v => { this.value = v; return v }, e => { this.onError?.(e); return this.value })
      .finally(() => { this.at = this.now(); this.pending = null })
    return this.pending
  }
}

/** IPv6 counts by its /64 (one line hands out a whole /64), IPv4-mapped IPv6 as the IPv4 address. */
export function ipKey(ipIn: string): string {
  const a = ipIn.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (isIP(a) !== 6) return a
  const hex = (parts: string[]) => parts.flatMap(p => {
    if (!p.includes('.')) return [p]
    const o = p.split('.').map(Number)
    return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)]
  })
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null]
  const h = hex(head ? head.split(':') : []), t = hex(tail ? tail.split(':') : [])
  const g = (tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]).map(x => parseInt(x || '0', 16))
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  return `${g.slice(0, 4).map(x => x.toString(16)).join(':')}::/64`
}

export interface LimitConfig { perHandleHour: number; perIpHour: number; perIpDay: number; perMinute: number; modelCallsDay: number }
export type Admission = { ok: true } | { ok: false; error: string; retryAfterMs: number }

export class Limits {
  private readonly steps: Array<{ l: WindowLimiter; key: (h: string, ip: string) => string; error: string }>
  constructor(cfg: LimitConfig, now: () => number = Date.now) {
    this.steps = [
      { l: new WindowLimiter(cfg.perHandleHour, HOUR, now), key: h => h, error: 'you have used your tries for this hour' },
      { l: new WindowLimiter(cfg.perIpHour, HOUR, now), key: (_, ip) => ip, error: 'this network has sent too many tries this hour' },
      { l: new WindowLimiter(cfg.perIpDay, DAY, now), key: (_, ip) => ip, error: 'this network has used its share of today' },
      { l: new WindowLimiter(cfg.perMinute, 60_000, now), key: () => 'all', error: 'the agent is busy; try again in a minute' },
      { l: new WindowLimiter(cfg.modelCallsDay, DAY, now), key: () => 'all', error: 'the agent is done for today; come back tomorrow' },
    ]
  }
  /** All must pass; only then is one used at every level. */
  admit(handle: string, ipIn: string): Admission {
    const ip = ipKey(ipIn), h = handle.toLowerCase()
    for (const s of this.steps) { const c = s.l.check(s.key(h, ip)); if (!c.ok) return { ok: false, error: s.error, retryAfterMs: c.retryAfterMs } }
    for (const s of this.steps) s.l.hit(s.key(h, ip))
    return { ok: true }
  }
}

export const isLoopback = (a: string) => a === '::1' || (isIP(a) === 4 && a.startsWith('127.'))
/** An IPv4-mapped IPv6 address ("::ffff:1.2.3.4") as plain IPv4; anything else as it came, trimmed. */
export const unmapIp = (a: string) => a.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')

/** The player's address: the socket's, or a header a proxy sets (believed only from loopback or a listed proxy). */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }, localHeader: string | null, trustedProxies: readonly string[] = []): string {
  const peer = unmapIp(req.socket.remoteAddress ?? 'unknown')
  if (localHeader && (isLoopback(peer) || trustedProxies.includes(peer.toLowerCase()))) {
    const raw = req.headers[localHeader], v = unmapIp(String(Array.isArray(raw) ? raw[0] : raw ?? ''))
    if (isIP(v)) return v
  }
  return peer
}

/** Why the proxy settings would leave every player in the proxy's rate-limit bucket; null when they do not. */
export function proxyTrustProblem(c: Pick<Config, 'fake' | 'host' | 'trustLocalHeader' | 'trustedProxies'>): string | null {
  if (c.trustedProxies.length && !c.trustLocalHeader) return 'DEMO_TRUSTED_PROXY is set, so set DEMO_TRUST_LOCAL_HEADER to the header that proxy sets'
  if (c.fake) return null
  if (isLoopback(c.host)) return c.trustLocalHeader ? null : 'behind a local proxy, set DEMO_TRUST_LOCAL_HEADER to the header it sets (for example cf-connecting-ip)'
  return c.trustedProxies.length ? null
    : `DEMO_HOST=${c.host} is not loopback, so the proxy connects from another address: list it in DEMO_TRUSTED_PROXY (in Docker, the pinned network gateway) and set DEMO_TRUST_LOCAL_HEADER`
}

/** Caps on what one slow or flooding client can hold open. */
export function hardenServer(server: Server): Server {
  server.maxConnections = MAX_CONNECTIONS
  server.requestTimeout = 10_000
  server.headersTimeout = 5_000
  return server
}
