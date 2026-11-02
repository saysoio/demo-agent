// One parser per API route: each takes what came over the wire and returns typed values or an error for the player.
// Player text is cleaned here, never filtered for meaning: tricking the agent is the game.
import type { IncomingMessage } from 'node:http'
import { CHANNELS, type Channel } from '../store.ts'
import { clip, tidy } from './text.ts'

export const MAX_TEXT_CHARS = 600
export const MAX_BODY = 4096
export const FEED_PAGE = 50

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** A request body the box will not read, with the HTTP status to answer. */
export class BodyRefused extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message); this.name = 'BodyRefused'; this.status = status }
}

/** Past MAX_BODY it stops buffering and refuses at once; the rest of the body drains unread while the 413 goes out. */
export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) { reject(new BodyRefused('send JSON')); return }
    let size = 0, over = false; const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      if (over) return
      size += c.length
      if (size <= MAX_BODY) { chunks.push(c); return }
      over = true; chunks.length = 0
      reject(new BodyRefused('too large', 413))
    })
    req.on('end', () => { if (over) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new BodyRefused('not JSON')) } })
    req.on('error', reject)
  })
}

const field = (b: unknown, k: string): unknown => (b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>)[k] : undefined)

/** A whole number in [min, max], from JSON or from a query string (digits only there). */
export function boundedInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}

export function cleanText(v: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof v !== 'string') return fail('text must be text')
  const text = tidy(v)
  if (!text) return fail('text is empty')
  if ([...text].length > MAX_TEXT_CHARS) return fail(`text must be at most ${MAX_TEXT_CHARS} characters`)
  return { ok: true, text }
}

export const MAX_FROM_CHARS = 120
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/
// a display name: letters (any script), spaces and . , ' & ( ) -; no quotes, angle brackets, slashes or digits
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .,'&()-]*$/u
const FROM_RULE: Record<Channel, string> = {
  email: 'from: an email address, like billing@northwind-hosting.example',
  invoice: 'from: an email address or Name <email>, like Northwind Hosting <billing@northwind-hosting.example>',
  post: 'from: an @handle of up to 30 letters, digits or _',
  chat: 'from: a name of up to 60 letters, spaces or . , \' & ( ) -',
}

/** Who the agent is told sent the item. Spoofing a vendor or a colleague is allowed (it is the game); the shape is not
 *  free: one address, handle or short name per channel, so the sender cannot carry markup, an address or a long
 *  instruction, or break out of its attribute. A short name can still say something ("Dana Okafor, CFO"): that is play. */
export function parseFrom(v: unknown, channel: Channel): { ok: true; from: string } | { ok: false; error: string } {
  // only a page from before senders leaves the field out
  if (v === undefined) return fail('this page is out of date: reload it to get the From field')
  if (typeof v !== 'string') return fail('from must be text')
  // NFKC folds look-alikes (fullwidth ＜ ＠) into the plain characters the rules below then judge
  const s = tidy(v.normalize('NFKC')).replace(/\s+/g, ' ')
  if (!s) return fail('from is empty')
  if ([...s].length > MAX_FROM_CHARS) return fail(`from must be at most ${MAX_FROM_CHARS} characters`)
  const bad = fail(FROM_RULE[channel])
  if (channel === 'post') {
    const h = s.replace(/^@/, '')
    return /^[A-Za-z0-9_]{1,30}$/.test(h) ? { ok: true, from: `@${h}` } : bad
  }
  if (channel === 'chat') return [...s].length <= 60 && NAME.test(s) ? { ok: true, from: s } : bad
  if (EMAIL.test(s)) return { ok: true, from: s }
  const m = channel === 'invoice' ? /^(.{1,60}?) ?<([^<>]+)>$/u.exec(s) : null
  if (m && NAME.test(m[1].trim()) && EMAIL.test(m[2])) return { ok: true, from: `${m[1].trim()} <${m[2]}>` }
  return bad
}

/** The sender stands for the player: there is no handle. A page from before handles were dropped still sends one; it
 *  is ignored here and never read, checked or kept. */
export interface Submit { channel: Channel; from: string; text: string }
export function parseSubmit(b: unknown): Parsed<Submit> {
  const t = cleanText(field(b, 'text')); if (!t.ok) return t
  const c = field(b, 'channel'), channel = CHANNELS.find(x => x === c)
  if (!channel) return fail(`channel must be one of ${CHANNELS.join(', ')}`)
  const f = parseFrom(field(b, 'from'), channel); if (!f.ok) return f
  return { ok: true, value: { channel, from: f.from, text: t.text } }
}

/** The newest page, a page before an id, or (ids=1,2,3) up to FEED_PAGE rows by id so the page can follow rows that
 *  fell off its newest page while still waiting. */
export interface FeedQuery { limit: number; before?: number; ids?: number[] }
export function parseFeedQuery(q: URLSearchParams): Parsed<FeedQuery> {
  const ids = q.get('ids')
  if (ids !== null) {
    if (q.has('before')) return fail('ask for ids or before, not both')
    const list = ids.split(',').map(x => boundedInt(x, 1, Number.MAX_SAFE_INTEGER))
    if (!ids || list.length > FEED_PAGE || list.some(x => x === null)) return fail(`ids must be 1 to ${FEED_PAGE} whole numbers, comma-separated`)
    return { ok: true, value: { limit: FEED_PAGE, ids: [...new Set(list as number[])] } }
  }
  const raw = q.get('before')
  if (raw === null || raw === '') return { ok: true, value: { limit: FEED_PAGE } }
  const before = boundedInt(raw, 1, Number.MAX_SAFE_INTEGER)
  return before === null ? fail('before must be a whole number') : { ok: true, value: { limit: FEED_PAGE, before } }
}

export interface AdminPause { paused: boolean; why: string }
export function parseAdminPause(b: unknown): Parsed<AdminPause> {
  const paused = field(b, 'paused'), why = field(b, 'why')
  if (typeof paused !== 'boolean') return fail('paused must be true or false')
  if (why !== undefined && typeof why !== 'string') return fail('why must be text')
  return { ok: true, value: { paused, why: clip(tidy(why ?? ''), 120) || 'paused by admin' } }
}

/** A prize claim: the winning try, the code its sender got back, and where to reach and pay them. The handle is kept
 *  for the operator only; letters, digits and @ . _ - + : / only, so it can never carry markup. */
export interface Claim { id: number; code: string; handle: string; payout: string }
export const MAX_HANDLE_CHARS = 80
const HANDLE = /^[\p{L}\p{N}@._+:\/ -]+$/u
export function parseClaim(b: unknown): Parsed<Claim> {
  const id = boundedInt(field(b, 'id'), 1, Number.MAX_SAFE_INTEGER), code = field(b, 'code'), handle = field(b, 'handle'), payout = field(b, 'payout')
  if (id === null) return fail('id must be a whole number')
  if (typeof code !== 'string' || !/^[0-9a-f]{32}$/.test(code)) return fail('the claim code is missing; claim from the page you sent the try from')
  const h = typeof handle === 'string' ? tidy(handle) : ''
  if (!h || [...h].length > MAX_HANDLE_CHARS || !HANDLE.test(h)) return fail(`handle: an X or Telegram handle or an email, up to ${MAX_HANDLE_CHARS} characters`)
  if (typeof payout !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(payout.trim())) return fail('payout: a 0x address on Base')
  return { ok: true, value: { id, code, handle: h, payout: payout.trim() } }
}

export interface AdminHide { id: number; hidden: boolean }
export function parseAdminHide(b: unknown): Parsed<AdminHide> {
  const id = boundedInt(field(b, 'id'), 1, Number.MAX_SAFE_INTEGER), hidden = field(b, 'hidden')
  if (id === null) return fail('id must be a whole number')
  if (hidden !== undefined && typeof hidden !== 'boolean') return fail('hidden must be true or false')
  return { ok: true, value: { id, hidden: hidden !== false } }
}
