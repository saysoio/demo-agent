// The agent's wallet: a viem client on a Coinbase CDP server-wallet account (the key never leaves Coinbase), guarded by
// the saysoio SDK in enforce mode. The code never pre-filters a payment: sayso decides. A block, an ask (nobody on duty
// to approve), or a slow or unverifiable answer all mean "not signed".
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, getAddress, http, parseGwei, type Account, type Address, type Chain, type Hex } from 'viem'
import { toAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { Oathline, OathlineBlocked, OathlineNeedsApproval, OathlineUnavailable, type CheckResult } from 'saysoio'
import type { Config, Vendor } from './config.ts'
import { cleanModelText, MODEL_TEXT } from './guard/index.ts'
import type { CheckRule, Outcome } from './store.ts'

export interface PayContext { reason: string; inputs: string[] }
export interface PayResult {
  outcome: Extract<Outcome, 'paid' | 'blocked' | 'asked' | 'unavailable' | 'error' | 'paused'>
  verdict: 'allow' | 'ask' | 'block' | null
  reason: string | null
  rule: CheckRule | null
  txHash: Hex | null
  checkMs: number
  note: string | null
}
export interface Payer {
  readonly address: Address
  /** amount in the asset's smallest unit (wei, or USDC's 6 decimals) */
  pay(to: Address, amount: bigint, ctx: PayContext, stop: () => boolean): Promise<PayResult>
  balance(): Promise<bigint>
  /** whether the transaction landed and succeeded; null when it could not be read in time */
  confirmed(hash: Hex): Promise<boolean | null>
}

class GamePaused extends Error { constructor() { super('the game was paused before signing'); this.name = 'GamePaused' } }
class FeesTooHigh extends Error { constructor() { super('network fees are above DEMO_MAX_FEE_GWEI'); this.name = 'FeesTooHigh' } }

export const chainFor = (chainId: number): Chain => {
  if (chainId === base.id) return base
  if (chainId === baseSepolia.id) return baseSepolia
  throw new Error(`unsupported chain ${chainId}`)
}

const isVerdict = (v: unknown): v is 'allow' | 'ask' | 'block' => v === 'allow' || v === 'ask' || v === 'block'

export class SaysoPayer implements Payer {
  readonly address: Address
  private readonly cfg: Config
  private readonly guarded: ReturnType<Oathline['guard']>
  private readonly reader: ReturnType<typeof createPublicClient>
  private queue: Promise<unknown> = Promise.resolve()
  private ctx: PayContext = { reason: '', inputs: [] }
  private last: CheckResult | null = null

  private stop: () => boolean = () => true

  constructor(cfg: Config, account: Account) {
    this.cfg = cfg
    this.address = getAddress(account.address)
    const chain = chainFor(cfg.chainId)
    const oathline = new Oathline({
      apiUrl: cfg.saysoApi, apiKey: cfg.secrets.sayso, chainId: cfg.chainId, mode: 'enforce', failClosed: true, signatures: 'refuse',
      onAsk: async () => false,
      context: () => ({ reason: this.ctx.reason, inputs: this.ctx.inputs }),
      onDecision: (result: CheckResult) => { this.last = result },
    })
    if (account.type !== 'local' || !account.signTransaction) throw new Error('the agent account must sign transactions itself')
    const inner = account
    // the pause once more between sayso's allow and the signature (an admin pause during a check stops it here)
    const signer = toAccount({
      address: inner.address,
      signMessage: () => Promise.reject(new Error('the agent signs no messages')),
      signTypedData: () => Promise.reject(new Error('the agent signs no typed data')),
      signTransaction: (tx, o) => (this.stop() ? Promise.reject(new GamePaused()) : inner.signTransaction!(tx, o)),
    })
    this.guarded = oathline.guard(createWalletClient({ account: signer, chain, transport: http(cfg.rpcUrl) }))
    this.reader = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
  }

  balance(): Promise<bigint> {
    if (!this.cfg.token) return this.reader.getBalance({ address: this.address })
    return this.reader.readContract({ address: this.cfg.token, abi: erc20Abi, functionName: 'balanceOf', args: [this.address] })
  }

  async confirmed(hash: Hex): Promise<boolean | null> {
    try { return (await this.reader.waitForTransactionReceipt({ hash, timeout: 90_000 })).status === 'success' } catch { return null }
  }

  /** read through a method: onDecision sets it during the send, which flow analysis cannot see */
  private lastCheck(): CheckResult | null { return this.last }

  /** saysoio 0.6.3 does not bound fees itself: a gas limit per kind of send and a ceiling on the fee per gas. */
  private async fees(): Promise<{ gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const cap = parseGwei(this.cfg.maxFeeGwei)
    const est = await this.reader.estimateFeesPerGas()
    if (est.maxFeePerGas > cap) throw new FeesTooHigh()
    return { gas: this.cfg.token ? 100_000n : 21_000n, maxFeePerGas: est.maxFeePerGas, maxPriorityFeePerGas: est.maxPriorityFeePerGas < est.maxFeePerGas ? est.maxPriorityFeePerGas : est.maxFeePerGas }
  }

  /** One payment at a time, so each check sees the wallet as it will be signed. */
  pay(to: Address, amount: bigint, ctx: PayContext, stop: () => boolean): Promise<PayResult> {
    const run = this.queue.then(() => this.payNow(to, amount, ctx, stop))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async payNow(to: Address, amount: bigint, ctx: PayContext, stop: () => boolean): Promise<PayResult> {
    const t0 = Date.now()
    if (stop()) return { outcome: 'paused', verdict: null, reason: null, rule: null, txHash: null, checkMs: 0, note: 'the game is paused; not checked, not signed' }
    this.ctx = ctx; this.last = null; this.stop = stop
    const tx = this.cfg.token
      ? { to: this.cfg.token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] }) }
      : { to: getAddress(to), value: amount, data: '0x' as Hex }
    let outcome: PayResult['outcome'], txHash: Hex | null = null, note: string | null = null
    try {
      txHash = await this.guarded.sendTransaction({ ...tx, ...(await this.fees()) } as any)
      outcome = 'paid'
    } catch (e) {
      if (e instanceof GamePaused || (e as Error)?.cause instanceof GamePaused) { outcome = 'paused'; note = 'the game was paused before signing; not signed' }
      else if (e instanceof FeesTooHigh) { outcome = 'error'; note = 'network fees are above the ceiling; not checked, not signed' }
      else if (e instanceof OathlineBlocked) outcome = 'blocked'
      else if (e instanceof OathlineNeedsApproval) outcome = 'asked'
      else if (e instanceof OathlineUnavailable) { outcome = 'unavailable'; note = 'no verified answer from Sayso in time; not signed' }
      else if (this.lastCheck()?.verdict === 'allow') { outcome = 'error'; note = 'allowed by Sayso, but the network did not accept the transaction' }
      else { outcome = 'error'; note = 'not signed (wallet error)' }
    }
    this.stop = () => true
    return { outcome, txHash, note, checkMs: Date.now() - t0, ...checkView(this.lastCheck(), outcome) }
  }
}

/** sayso's verdict, reason and rule as kept and shown; none for an unverified answer. The reason is cleaned like model text. */
export function checkView(r: CheckResult | null, outcome: PayResult['outcome']): Pick<PayResult, 'verdict' | 'reason' | 'rule'> {
  if (!r || outcome === 'unavailable') return { verdict: null, reason: null, rule: null }
  return { verdict: isVerdict(r.verdict) ? r.verdict : null, reason: cleanModelText(r.reason, MODEL_TEXT.reason), rule: firedRule(r) }
}

// sayso's rule ids (apps/api/src/rules/hard.ts); an id not named here shows no tag
const RULE_IDS = new Map<string, CheckRule>([
  ['per-trade-cap', 'cap'], ['daily-cap', 'cap'], ['weekly-cap', 'cap'], ['weekly-cap-default', 'cap'],
  ['recipient-unknown', 'unknown payee'], ['recipient-new', 'unknown payee'],
])

// sayso's injection thresholds for strictness "normal" (apps/api/src/check.ts:25, THRESHOLDS.normal); setup signs normal
const INJECTION_BLOCK = 0.65
const INJECTION_ASK = 0.4

/** Which check stopped it, from the rule ids and the judge's injection score, never from text. Like sayso's own
 *  decision: a block rule decides a block; with none, the judge did. An ask names injection first, then its rule.
 *  These fields are not covered by sayso's signed receipt, so they only label the feed. */
export function firedRule(r: CheckResult): CheckRule | null {
  if (r.verdict !== 'block' && r.verdict !== 'ask') return null
  const rules: unknown[] = Array.isArray(r.rules) ? r.rules : []
  const hit = rules.find((x: any) => x?.verdict === r.verdict && typeof x.id === 'string') as { id: string } | undefined
  const judge = r.judge && typeof r.judge === 'object' ? r.judge as { injectionTriggered?: unknown } : null
  const injection = typeof judge?.injectionTriggered === 'number' && judge.injectionTriggered >= (r.verdict === 'block' ? INJECTION_BLOCK : INJECTION_ASK)
  if (r.verdict === 'ask' && injection) return 'injection'
  if (hit) return RULE_IDS.get(hit.id.replace(/^owner-override:/, '')) ?? null
  if (!judge) return null
  return injection ? 'injection' : 'judge'
}

/** A stand-in for local runs and tests: "sayso" allows only vendors, up to twice their usual amount. */
export class FakePayer implements Payer {
  readonly address: Address = getAddress('0x00000000000000000000000000000000000d3e00')
  private bal: bigint
  private readonly vendors: Vendor[]
  private readonly toUnits: (s: string) => bigint
  readonly sent: Array<{ to: Address; amount: bigint; ctx: PayContext }> = []
  constructor(vendors: Vendor[], toUnits: (s: string) => bigint, balance: bigint) { this.vendors = vendors; this.toUnits = toUnits; this.bal = balance }
  async balance() { return this.bal }
  async confirmed(_hash: Hex) { return true }
  async pay(to: Address, amount: bigint, ctx: PayContext, stop: () => boolean): Promise<PayResult> {
    if (stop()) return { outcome: 'paused', verdict: null, reason: null, rule: null, txHash: null, checkMs: 0, note: 'the game is paused; not checked, not signed' }
    const v = this.vendors.find(x => x.address === getAddress(to))
    if (!v) return { outcome: 'blocked', verdict: 'block', reason: 'payee is not in the owner\'s vendor list', rule: 'unknown payee', txHash: null, checkMs: 5, note: null }
    if (amount > this.toUnits(v.usual) * 2n) return { outcome: 'blocked', verdict: 'block', reason: 'more than the per-payment cap', rule: 'cap', txHash: null, checkMs: 5, note: null }
    if (amount > this.bal) return { outcome: 'error', verdict: 'allow', reason: 'allowed', rule: null, txHash: null, checkMs: 5, note: 'not enough balance' }
    this.bal -= amount
    this.sent.push({ to: getAddress(to), amount, ctx })
    return { outcome: 'paid', verdict: 'allow', reason: 'known vendor, within the cap', rule: null, txHash: `0x${(this.sent.length).toString(16).padStart(64, '0')}`, checkMs: 5, note: null }
  }
}
