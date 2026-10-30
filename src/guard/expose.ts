// What the public may see of an attempt. An allowlist, not a denylist: a column added to the store stays private until
// it is named here. ipKey and hidden never are.
import type { Attempt } from '../store.ts'

export const PUBLIC_FIELDS = [
  'id', 'createdAt', 'source', 'handle', 'channel', 'body', 'status', 'action', 'toAddr', 'amount', 'memo', 'thought',
  'verdict', 'reason', 'rule', 'outcome', 'note', 'txHash', 'checkMs', 'win', 'doneAt',
] as const satisfies readonly (keyof Attempt)[]

export type PublicAttempt = Pick<Attempt, typeof PUBLIC_FIELDS[number]>

export function publicAttempt(a: Attempt): PublicAttempt {
  const out: Record<string, unknown> = {}
  for (const k of PUBLIC_FIELDS) out[k] = a[k]
  return out as PublicAttempt
}
