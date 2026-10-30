// One row per attempt: what came in, what the agent proposed, what sayso said, what happened onchain. SQLite on the
// box (node:sqlite); /game/ reads it through the server's public feed, which shows only the fields in src/guard/expose.ts.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** How an inbox item arrives. The one list: the type, the submit parser and the prompt all follow it. */
export const CHANNELS = ['email', 'invoice', 'post', 'chat'] as const
export type Channel = typeof CHANNELS[number]
export type Source = 'player' | 'vendor'
export type Status = 'queued' | 'thinking' | 'done'
export type Outcome = 'paid' | 'blocked' | 'asked' | 'skipped' | 'invalid' | 'unavailable' | 'error' | 'paused'
/** Which of sayso's checks stopped a payment, in our own words (never the server's text). */
export const CHECK_RULES = ['cap', 'unknown payee', 'injection', 'judge'] as const
export type CheckRule = typeof CHECK_RULES[number]

export interface Attempt {
  id: number
  createdAt: number
  source: Source
  handle: string
  ipKey: string
  channel: Channel
  body: string
  status: Status
  action: 'pay' | 'skip' | null
  toAddr: string | null
  amount: string | null
  memo: string | null
  thought: string | null
  verdict: 'allow' | 'ask' | 'block' | null
  reason: string | null
  rule: CheckRule | null
  outcome: Outcome | null
  note: string | null
  txHash: string | null
  checkMs: number | null
  /** money left for an address that is not a vendor: the pot was broken */
  win: boolean
  hidden: boolean
  doneAt: number | null
}

export interface Result {
  action: Attempt['action']; toAddr: string | null; amount: string | null; memo: string | null; thought: string | null
  verdict: Attempt['verdict']; reason: string | null; rule: CheckRule | null; outcome: Outcome; note: string | null; txHash: string | null; checkMs: number | null; win: boolean
}

const COLS = `id, created_at, source, handle, ip_key, channel, body, status, action, to_addr, amount, memo, thought, verdict, reason,
  check_rule, outcome, note, tx_hash, check_ms, win, hidden, done_at`

function row(r: any): Attempt {
  return {
    id: Number(r.id), createdAt: Number(r.created_at), source: r.source, handle: r.handle, ipKey: r.ip_key, channel: r.channel, body: r.body,
    status: r.status, action: r.action, toAddr: r.to_addr, amount: r.amount, memo: r.memo, thought: r.thought, verdict: r.verdict,
    reason: r.reason, rule: r.check_rule ?? null, outcome: r.outcome, note: r.note, txHash: r.tx_hash, checkMs: r.check_ms === null ? null : Number(r.check_ms),
    win: !!r.win, hidden: !!r.hidden, doneAt: r.done_at === null ? null : Number(r.done_at),
  }
}

export class Store {
  private readonly db: DatabaseSync
  private readonly now: () => number
  constructor(path: string, now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.now = now
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, source TEXT NOT NULL, handle TEXT NOT NULL,
        ip_key TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        action TEXT, to_addr TEXT, amount TEXT, memo TEXT, thought TEXT, verdict TEXT, reason TEXT, outcome TEXT, note TEXT,
        tx_hash TEXT, check_ms INTEGER, win INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
        check_rule TEXT
      );
      CREATE INDEX IF NOT EXISTS attempts_status ON attempts (status, id);
      CREATE TABLE IF NOT EXISTS flags (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    // databases made before check_rule existed
    if (!(this.db.prepare(`PRAGMA table_info(attempts)`).all() as any[]).some(c => c.name === 'check_rule')) this.db.exec(`ALTER TABLE attempts ADD COLUMN check_rule TEXT`)
    // a restart mid-check leaves rows "thinking": nothing was confirmed for them, so they end as errors
    this.db.prepare(`UPDATE attempts SET status = 'done', outcome = 'error', note = 'the agent restarted during this attempt', done_at = ? WHERE status = 'thinking'`).run(this.now())
  }

  add(a: { source: Source; handle: string; ipKey: string; channel: Channel; body: string }): number {
    const r = this.db.prepare(`INSERT INTO attempts (created_at, source, handle, ip_key, channel, body) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(this.now(), a.source, a.handle, a.ipKey, a.channel, a.body)
    return Number(r.lastInsertRowid)
  }

  queued(): number { return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE status = 'queued'`).get() as any).n) }

  /** The oldest queued attempt, marked "thinking" in the same step. */
  claimNext(): Attempt | null {
    const r = this.db.prepare(`UPDATE attempts SET status = 'thinking' WHERE id = (SELECT id FROM attempts WHERE status = 'queued' ORDER BY id LIMIT 1) RETURNING ${COLS}`).get()
    return r ? row(r) : null
  }

  finish(id: number, x: Result) {
    this.db.prepare(`UPDATE attempts SET status = 'done', action = ?, to_addr = ?, amount = ?, memo = ?, thought = ?, verdict = ?, reason = ?,
      check_rule = ?, outcome = ?, note = ?, tx_hash = ?, check_ms = ?, win = ?, done_at = ? WHERE id = ?`)
      .run(x.action, x.toAddr, x.amount, x.memo, x.thought, x.verdict, x.reason, x.rule, x.outcome, x.note, x.txHash, x.checkMs, x.win ? 1 : 0, this.now(), id)
  }

  /** These rows by id, newest first, hidden rows left out. */
  feedRows(ids: readonly number[]): Attempt[] {
    return this.db.prepare(`SELECT ${COLS} FROM attempts WHERE hidden = 0 AND id IN (SELECT value FROM json_each(?)) ORDER BY id DESC`).all(JSON.stringify(ids)).map(row)
  }

  /** Newest first, hidden rows left out; `before` pages back by id. Whole rows: the caller projects them for the public. */
  feed(limit = 50, before?: number): Attempt[] {
    const rows = before
      ? this.db.prepare(`SELECT ${COLS} FROM attempts WHERE hidden = 0 AND id < ? ORDER BY id DESC LIMIT ?`).all(before, limit)
      : this.db.prepare(`SELECT ${COLS} FROM attempts WHERE hidden = 0 ORDER BY id DESC LIMIT ?`).all(limit)
    return rows.map(row)
  }

  /** Player tries the agent fell for and sayso stopped: it proposed a payment and the verdict or outcome was a block.
   *  Newest first, hidden rows left out. */
  tricks(limit = 10): Attempt[] {
    return this.db.prepare(`SELECT ${COLS} FROM attempts WHERE hidden = 0 AND source = 'player' AND status = 'done' AND action = 'pay'
      AND (verdict = 'block' OR outcome = 'blocked') ORDER BY id DESC LIMIT ?`).all(limit).map(row)
  }

  stats(): { attempts: number; blocked: number; paid: number; wins: number } {
    const r = this.db.prepare(`SELECT COUNT(*) AS attempts, SUM(outcome IN ('blocked', 'asked')) AS blocked, SUM(outcome = 'paid') AS paid, SUM(win) AS wins FROM attempts WHERE source = 'player'`).get() as any
    return { attempts: Number(r.attempts ?? 0), blocked: Number(r.blocked ?? 0), paid: Number(r.paid ?? 0), wins: Number(r.wins ?? 0) }
  }

  hide(id: number, hidden: boolean): boolean { return this.db.prepare(`UPDATE attempts SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id).changes > 0 }

  flag(name: string): string | null { const r = this.db.prepare(`SELECT value FROM flags WHERE name = ?`).get(name) as any; return r ? String(r.value) : null }
  setFlag(name: string, value: string | null) {
    if (value === null) this.db.prepare(`DELETE FROM flags WHERE name = ?`).run(name)
    else this.db.prepare(`INSERT INTO flags (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run(name, value)
  }

  close() { this.db.close() }
}
