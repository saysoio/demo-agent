// The two admin calls: only from the box itself, never through the proxy (which sets its header or x-forwarded-for),
// with the token, and a few wrong tokens per hour at most. Only wrong tokens count, so the right one always gets in.
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { ipKey, isLoopback, unmapIp, WindowLimiter } from './limits.ts'

export function tokenOk(given: string | undefined, want: string): boolean {
  const a = Buffer.from(given?.replace(/^Bearer\s+/i, '') ?? ''), b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type AdminRefusal = { status: number; error: string }

export class AdminGate {
  private readonly tries: WindowLimiter
  private readonly token: string
  private readonly localHeader: string | null
  constructor(o: { token: string; localHeader: string | null; now?: () => number }) {
    this.token = o.token; this.localHeader = o.localHeader; this.tries = new WindowLimiter(10, 3600_000, o.now)
  }
  /** null when the call may go ahead. Anything not from the box itself gets the same 404 as a missing route. */
  check(req: IncomingMessage): AdminRefusal | null {
    const peer = unmapIp(req.socket.remoteAddress ?? '')
    const direct = isLoopback(peer) && !req.headers['x-forwarded-for'] && !(this.localHeader && req.headers[this.localHeader])
    if (!direct) return { status: 404, error: 'not found' }
    if (tokenOk(req.headers.authorization, this.token)) return null
    const key = ipKey(peer)
    if (!this.tries.check(key).ok) return { status: 429, error: 'slow down' }
    this.tries.hit(key)
    return { status: 401, error: 'no' }
  }
}
