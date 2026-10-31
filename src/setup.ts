// One-time setup, run by the OWNER on their own Mac, never on the box: the owner key can switch the agent to shadow
// mode, so it never goes near the machine that faces players. Claude does not run it.
// It looks up (or creates) the agent's CDP server-wallet account, registers it at sayso with the owner, has sayso
// compile the published rules, shows them next to the text, and on "sign" signs them as the mandate and turns
// enforce on (sayso's server switch needs a linked Telegram chat; the box enforces through the SDK either way). The
// agent's sayso API key goes to <DEMO_DATA_DIR>/sayso-api-key (this user only) for DEMO_SAYSO_API_KEY.
//
//   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… CDP_WALLET_SECRET=… OWNER_PRIVATE_KEY=… DEMO_VENDORS=… npm run setup
//
// Nothing here moves money. No key is printed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { getAddress, parseUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import { compileMandate, mandateHash, providerSigner, registerWallet, setCheckMode, setMandate, type CallOptions } from 'saysoio'
import { decimalsFor, loadConfig, unitName, type Network, type Vendor } from './config.ts'
import { perPaymentCap, publishedRules, SIGNED_RULES_FILE, type Published, type SignedRules } from './rules.ts'

export { caps } from './config.ts'
export { publishedRules, type Published } from './rules.ts'

const KNOWN_FIELDS = new Set(['summary', 'allowedTokens', 'blockedTokens', 'maxPerTradeEth', 'dailyCapEth', 'maxPerTradeUsd', 'dailyCapUsd', 'weeklyCapEth', 'weeklyCapUsd', 'unresolved', 'savedAddresses', 'allowedActions', 'targetAllocation', 'strictness', 'ownContracts'])
/** Exact, in the asset's smallest unit: a number is read by its shortest decimal form; anything finer never matches. */
const same = (a: unknown, b: string, decimals: number) => {
  if (typeof a !== 'number' && typeof a !== 'string') return false
  const s = typeof a === 'number' ? (Number.isFinite(a) && a >= 0 ? String(a) : '') : a.trim()
  if (!/^\d+(\.\d+)?$/.test(s) || (s.split('.')[1]?.length ?? 0) > decimals) return false
  return parseUnits(s, decimals) === parseUnits(b, decimals)
}
const addr = (v: unknown) => { try { return getAddress(String(v)) } catch { return null } }

/** Why the compiled rules are not the published ones (empty when they are). Same idea as sayso's game setup check. */
export function compiledProblems(c: any, r: Published): string[] {
  if (!c || typeof c !== 'object') return ['the compiler returned no rules']
  const p: string[] = []
  const [perKey, dayKey, weekKey, otherPer, otherDay, otherWeek] = r.asset === 'eth'
    ? ['maxPerTradeEth', 'dailyCapEth', 'weeklyCapEth', 'maxPerTradeUsd', 'dailyCapUsd', 'weeklyCapUsd']
    : ['maxPerTradeUsd', 'dailyCapUsd', 'weeklyCapUsd', 'maxPerTradeEth', 'dailyCapEth', 'weeklyCapEth']
  const dec = decimalsFor(r.asset)
  if (!same(c[perKey], r.max, dec)) p.push(`per-payment cap is ${c[perKey] ?? 'missing'}, not ${r.max}`)
  if (!same(c[dayKey], r.daily, dec)) p.push(`daily cap is ${c[dayKey] ?? 'missing'}, not ${r.daily}`)
  if (!same(c[weekKey], r.weekly, dec)) p.push(`weekly cap is ${c[weekKey] ?? 'missing'}, not ${r.weekly}`)
  if (c[otherPer] != null || c[otherDay] != null || c[otherWeek] != null) p.push('it added a cap in another unit')
  const saved = (Array.isArray(c.savedAddresses) ? c.savedAddresses : []).map(addr)
  const want = new Set(r.vendors)
  if (saved.length !== want.size || saved.some((a: Address | null) => !a || !want.has(a))) p.push(`saved addresses are [${saved.join(', ')}], not exactly the vendors`)
  const actions: unknown[] = Array.isArray(c.allowedActions) ? c.allowedActions : []
  if (actions.length !== 1 || actions[0] !== 'transfer') p.push(`allowed actions are [${actions.join(', ')}], not only transfer`)
  // allowedTokens lists what the agent may trade into; with transfer the only action, none or the asset itself is fine
  const tokens = (Array.isArray(c.allowedTokens) ? c.allowedTokens : []).map((t: unknown) => String(t).toUpperCase())
  const asset = r.asset === 'eth' ? ['ETH', 'WETH'] : [unitName(r.asset)]
  if (tokens.some((t: string) => !asset.includes(t))) p.push(`allowed tokens are [${tokens.join(', ')}], more than ${asset.join(' and ')}`)
  if (c.ownContracts != null && !(Array.isArray(c.ownContracts) && c.ownContracts.length === 0)) p.push('it lets the agent call contracts')
  const unknown = Object.keys(c).filter(k => !KNOWN_FIELDS.has(k))
  if (unknown.length) p.push(`it has fields setup does not know: ${unknown.join(', ')}`)
  if (c.targetAllocation != null) p.push('it added a target allocation')
  if (Array.isArray(c.unresolved) && c.unresolved.length) p.push(`the compiler could not turn these into rules: ${c.unresolved.join('; ')}`)
  if (c.strictness !== 'strict' && c.strictness !== 'normal') p.push(`strictness is ${c.strictness ?? 'missing'}, not strict or normal`)
  return p
}

/** What the box is given of the signed mandate (src/rules.ts): the published text and caps, the vendors, and the
 *  strictness and hash of what sayso compiled and the owner signed. */
export function signedRecord(r: Published, vendors: Vendor[], network: Network, signed: unknown, mandateId: Hex | null, at: Date): SignedRules {
  const c = signed as { strictness?: unknown }
  if (c.strictness !== 'strict' && c.strictness !== 'normal') throw new Error('the signed rules have no strict or normal strictness')
  return {
    text: r.text, vendors: vendors.map(v => ({ name: v.name, address: v.address })), max: r.max, daily: r.daily, weekly: r.weekly,
    asset: r.asset, network, strictness: c.strictness, mandateId, mandateHash: mandateHash(signed), signedAt: at.toISOString(),
  }
}

/** sayso refuses its enforce switch until a Telegram chat is linked for the wallet (409); the SDK's error carries it. */
export const needsTelegram = (e: unknown) => /^sayso \/wallets\/0x[0-9a-fA-F]{40}\/mode 409: link Telegram/.test(String((e as Error)?.message ?? ''))

/** Turns sayso's enforce switch on; true when it did, false when no Telegram chat is linked. Any other refusal throws. */
export async function switchEnforce(set: () => Promise<unknown>, log: (s: string) => void = console.log): Promise<boolean> {
  try { await set(); return true } catch (e) {
    if (!needsTelegram(e)) throw e
    log('note: sayso\'s server-side enforce switch needs a linked Telegram chat, and none is linked; it stays off. '
      + 'The box enforces anyway: its SDK (saysoio 0.7.0) runs in enforce mode (src/wallet.ts), so a block, an ask or a check '
      + 'without a signed answer is never signed.')
    return false
  }
}

/** sayso's answer when this wallet is registered already: to this owner it changes nothing, and the key stays as it was. */
export const alreadyRegistered = (e: unknown) => /^sayso \/wallets\/register 409: this wallet is already registered;/.test(String((e as Error)?.message ?? ''))

/** Registers the wallet and returns its new API key, or null when this owner registered it before: then sayso keeps the
 *  key it gave the first time, and setup only signs the new rules. A wallet linked to another owner still fails. */
export async function register(reg: () => Promise<{ apiKey: string }>, log: (s: string) => void = console.log): Promise<string | null> {
  try { return (await reg()).apiKey } catch (e) {
    if (!alreadyRegistered(e)) throw e
    log('note: this wallet is already registered to this owner; its API key stays as it is (the box keeps using it), and only the rules are signed again.')
    return null
  }
}

async function confirmed(): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question('type "sign" to register the wallet, sign these rules and turn enforce on: ')).trim() === 'sign' } finally { rl.close() }
}

async function main() {
  const env = process.env
  const cfg = loadConfig({ ...env, DEMO_SAYSO_API_KEY: 'not-yet', ANTHROPIC_API_KEY: 'not-needed', DEMO_ADMIN_TOKEN: 'x'.repeat(32) })
  const health = await fetch(`${cfg.saysoApi}/health`).then(r => r.json()).catch(() => null) as { chainId?: number } | null
  if (health?.chainId !== cfg.chainId) throw new Error(`${cfg.saysoApi} is not sayso's server for chain ${cfg.chainId}`)
  const ownerKey = env.OWNER_PRIVATE_KEY?.trim()
  if (!ownerKey) throw new Error('missing OWNER_PRIVATE_KEY')
  const owner = privateKeyToAccount(ownerKey as Hex)
  const { CdpClient } = await import('@coinbase/cdp-sdk')
  const cdp = new CdpClient(cfg.secrets.cdp!)
  const agent = toAccount(await cdp.evm.getOrCreateAccount({ name: cfg.cdpAccountName }) as any)
  console.log(`agent wallet (CDP account "${cfg.cdpAccountName}"): ${agent.address}\nowner: ${owner.address}`)
  if (cfg.vendors.some(v => v.address === agent.address || v.address === owner.address)) throw new Error('a vendor address is the agent or the owner')

  const rules = publishedRules(cfg.vendors, cfg.asset, perPaymentCap(cfg), cfg.caps.daily, cfg.caps.weekly)
  const { compiled, shownToOwner } = await compileMandate(cfg.saysoApi, rules.text)
  console.log(`\nthe published rules:\n  "${rules.text}"\n\nsayso compiled them as:\n${JSON.stringify(compiled, null, 2)}\n\nsayso's summary for the owner:\n${shownToOwner}\n`)
  const problems = compiledProblems(compiled, rules)
  if (problems.length) throw new Error(`the compiled rules are not the published ones, so nothing was signed:\n- ${problems.join('\n- ')}`)
  if (!(await confirmed())) throw new Error('not confirmed; nothing was registered or signed')

  const opts: CallOptions = { chainId: cfg.chainId, ...(env.DEMO_INVITE ? { invite: env.DEMO_INVITE } : {}) }
  const apiKey = await register(() => registerWallet(cfg.saysoApi, providerSigner(agent as any), owner.address, opts))
  const signed = { ...compiled, summary: rules.text }
  const { mandateId } = await setMandate(cfg.saysoApi, owner, agent.address, rules.text, signed, opts)
  const switched = await switchEnforce(() => setCheckMode(cfg.saysoApi, owner, agent.address, 'enforce', opts))
  mkdirSync(cfg.dataDir, { recursive: true })
  const file = join(cfg.dataDir, 'sayso-api-key')
  if (apiKey) writeFileSync(file, `${apiKey}\n`, { mode: 0o600 })
  const rulesFile = join(cfg.dataDir, SIGNED_RULES_FILE)
  writeFileSync(rulesFile, `${JSON.stringify(signedRecord(rules, cfg.vendors, cfg.network, signed, mandateId ?? null, new Date()), null, 2)}\n`, { mode: 0o644 })
  console.log(`done: ${agent.address} ${apiKey ? 'registered' : 'was registered already'}, rules signed, enforce on${switched ? '' : ' in the SDK (server switch off)'}. ${apiKey ? `API key written to ${file} (put it in DEMO_SAYSO_API_KEY on the box)` : 'The API key on the box stays'}; the signed rules to ${rulesFile} (copy it to the box's data volume).`)
}

if (import.meta.main) main().catch(e => { console.error(`setup failed: ${(e as Error).message}`); process.exit(1) })
