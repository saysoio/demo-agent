// What the model costs. Each call's tokens are priced per million: cache writes at 1.25x and cache reads at 0.1x the
// input price (Anthropic's multipliers for a 5-minute cache). The budget is per UTC day: reaching it pauses the game
// (src/agent.ts) until the next day.
export interface Usage { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface Prices { inPerMtok: number; outPerMtok: number }
export interface SpendTotals { calls: number; input: number; output: number; cacheWrite: number; cacheRead: number; usd: number }

const DAY = 86_400_000

/** The pause reason the budget sets; the page reads it as "paused for budget". */
export const BUDGET_PAUSE = 'the model budget for today is used up'

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/** The Anthropic response's usage block as plain counts; missing or odd fields count as 0. */
export function usageOf(u: unknown): Usage {
  const x = (u ?? {}) as Record<string, unknown>
  return { input: count(x.input_tokens), output: count(x.output_tokens), cacheWrite: count(x.cache_creation_input_tokens), cacheRead: count(x.cache_read_input_tokens) }
}

export function callCost(u: Usage, p: Prices): number {
  return (u.input * p.inPerMtok + u.cacheWrite * p.inPerMtok * 1.25 + u.cacheRead * p.inPerMtok * 0.1 + u.output * p.outPerMtok) / 1e6
}

export const dayStart = (t: number) => t - (t % DAY)
export const dayName = (t: number) => new Date(dayStart(t)).toISOString().slice(0, 10)

export function spendLine(day: number, s: SpendTotals): string {
  return `model spend ${dayName(day)}: ${s.calls} calls, $${s.usd.toFixed(4)} (in ${s.input}, out ${s.output}, cache write ${s.cacheWrite}, cache read ${s.cacheRead} tokens)`
}

/** A tick that logs the finished day's spend once the UTC day turns. */
export function dailySpendLog(read: (from: number, to: number) => SpendTotals, log: (m: string) => void, now: () => number = Date.now): () => void {
  let day = dayStart(now())
  return () => {
    const d = dayStart(now())
    if (d === day) return
    log(spendLine(day, read(day, day + DAY)))
    day = d
  }
}
