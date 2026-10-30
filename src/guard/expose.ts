// What the public may see: of an attempt, of the pot, of the rules and of a stopped trick. Allowlists, not denylists:
// a column added to the store or a field added to a view stays private until it is named here. ipKey and hidden never are.
import type { Attempt } from '../store.ts'
import { clip } from './text.ts'

export const PUBLIC_FIELDS = [
  'id', 'createdAt', 'source', 'handle', 'channel', 'body', 'status', 'action', 'toAddr', 'amount', 'memo', 'thought',
  'verdict', 'reason', 'rule', 'outcome', 'note', 'txHash', 'checkMs', 'win', 'doneAt',
] as const satisfies readonly (keyof Attempt)[]

export type PublicAttempt = Pick<Attempt, typeof PUBLIC_FIELDS[number]>

export const POT_FIELDS = [
  'address', 'balance', 'unit', 'network', 'chainId', 'explorerBase', 'paused', 'budgetPaused', 'queued', 'stats', 'vendors', 'limits', 'source',
] as const

export const RULES_FIELDS = [
  'source', 'signedAt', 'text', 'unit', 'network', 'vendors', 'perPayment', 'daily', 'weekly', 'actions', 'strictness', 'sdk', 'checkServer', 'signedVerdicts',
] as const

/** Nested objects get allowlists of their own. */
export const STATS_FIELDS = ['attempts', 'blocked', 'paid', 'wins', 'pending'] as const
export const VENDOR_FIELDS = ['name', 'address'] as const
export const LIMIT_FIELDS = ['textChars', 'feedPage'] as const
export const SDK_FIELDS = ['name', 'version', 'mode'] as const

/** A stopped trick shows the player text as a short excerpt, never in full. */
export const TRICK_FIELDS = ['id', 'createdAt', 'handle', 'channel', 'toAddr', 'amount', 'rule', 'reason'] as const satisfies readonly (keyof Attempt)[]
export const TRICK_EXCERPT = 140

function pick<K extends string>(from: Partial<Record<K, unknown>>, fields: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>
  for (const k of fields) out[k] = from[k]
  return out
}

export const publicAttempt = (a: Attempt): PublicAttempt => pick(a, PUBLIC_FIELDS) as PublicAttempt
type Loose = Record<string, unknown> | null | undefined
const sub = <K extends string>(v: unknown, fields: readonly K[]) => (v && typeof v === 'object' ? pick(v as Loose & object, fields) : null)
const subs = <K extends string>(v: unknown, fields: readonly K[]) => (Array.isArray(v) ? v.map(x => sub(x, fields)) : [])

export function publicPot(p: Partial<Record<typeof POT_FIELDS[number], unknown>>) {
  return { ...pick(p, POT_FIELDS), stats: sub(p.stats, STATS_FIELDS), vendors: subs(p.vendors, VENDOR_FIELDS), limits: sub(p.limits, LIMIT_FIELDS) }
}

export function publicRules(r: Partial<Record<typeof RULES_FIELDS[number], unknown>>) {
  return {
    ...pick(r, RULES_FIELDS), vendors: subs(r.vendors, VENDOR_FIELDS), sdk: sub(r.sdk, SDK_FIELDS),
    actions: Array.isArray(r.actions) ? r.actions.filter(a => typeof a === 'string') : [],
  }
}

/** Text on one line, clipped to n characters with an ellipsis. */
export function excerpt(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return [...one].length > n ? `${clip(one, n - 1).trimEnd()}…` : one
}

export const publicTrick = (a: Attempt) => ({ ...pick(a, TRICK_FIELDS), excerpt: excerpt(a.body, TRICK_EXCERPT) })
