// Containment of what the model says. Player text reaches the model on purpose (that is the game), so nothing is
// filtered on the way in; instead the decision is held to its shape and its text is cleaned before it is kept or shown.
import { getAddress, parseUnits, type Address } from 'viem'
import type { Decision } from '../brain.ts'
import { clip, tidy } from './text.ts'

export type Checked = { kind: 'skip' } | { kind: 'pay'; to: Address; amount: bigint } | { kind: 'invalid'; why: string }

/** Shape only: a real address and a positive amount the asset can hold. Whether to pay is sayso's call, not ours. */
export function checkDecision(d: Decision, decimals: number): Checked {
  if (d.action === 'skip') return { kind: 'skip' }
  const to = d.to?.trim() ?? ''
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { kind: 'invalid', why: 'the agent named no valid address' }
  const amt = d.amount?.trim() ?? ''
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(amt)
  if (!m || (m[2]?.length ?? 0) > decimals) return { kind: 'invalid', why: 'the agent named no valid amount' }
  const amount = parseUnits(amt, decimals)
  if (amount <= 0n) return { kind: 'invalid', why: 'the amount is zero' }
  return { kind: 'pay', to: getAddress(to.toLowerCase()), amount }
}

/** Model text as it may be stored and shown: control and format characters out, then clipped; null when nothing is left. */
export function cleanModelText(s: unknown, n: number): string | null {
  if (typeof s !== 'string') return null
  return clip(tidy(s), n) || null
}

/** Lengths kept of each text the model writes, and of sayso's reason, which is shown next to it. */
export const MODEL_TEXT = { memo: 80, thought: 300, to: 60, amount: 30, reason: 300 } as const
