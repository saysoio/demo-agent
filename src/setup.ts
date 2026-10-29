// One-time setup, run by the OWNER on their own Mac, never on the box: the owner key can switch the agent to shadow
// mode, so it never goes near the machine that faces players. Claude does not run it.
// It looks up (or creates) the agent's CDP server-wallet account, registers it at sayso with the owner, has sayso
// compile the published rules, shows them next to the text, and on "sign" signs them as the mandate and turns
// enforce on. The agent's sayso API key goes to <DEMO_DATA_DIR>/sayso-api-key (this user only) for DEMO_SAYSO_API_KEY.
//
//   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… CDP_WALLET_SECRET=… OWNER_PRIVATE_KEY=… DEMO_VENDORS=… npm run setup
//
// Nothing here moves money. No key is printed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { getAddress, parseUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import { compileMandate, providerSigner, registerWallet, setCheckMode, setMandate } from 'saysoio'
import { decimalsFor, loadConfig, unitName, type Asset, type Vendor } from './config.ts'

export interface Published { text: string; vendors: Address[]; max: string; daily: string; asset: Asset }

export function publishedRules(vendors: Vendor[], asset: Asset, max: string, daily: string): Published {
  const unit = unitName(asset)
  const list = vendors.map(v => `${v.name} (${v.address})`).join(', ')
  const text = `The agent may send ${unit} only to these vendors: ${list}; at most ${max} ${unit} per payment and ${daily} ${unit} a day in total; `
    + `nothing else: no other tokens, no contracts, no approvals, no signatures.`
  return { text, vendors: vendors.map(v => v.address), max, daily, asset }
}

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
  const [perKey, dayKey, otherPer, otherDay] = r.asset === 'eth' ? ['maxPerTradeEth', 'dailyCapEth', 'maxPerTradeUsd', 'dailyCapUsd'] : ['maxPerTradeUsd', 'dailyCapUsd', 'maxPerTradeEth', 'dailyCapEth']
  const dec = decimalsFor(r.asset)
  if (!same(c[perKey], r.max, dec)) p.push(`per-payment cap is ${c[perKey] ?? 'missing'}, not ${r.max}`)
  if (!same(c[dayKey], r.daily, dec)) p.push(`daily cap is ${c[dayKey] ?? 'missing'}, not ${r.daily}`)
  if (c[otherPer] != null || c[otherDay] != null) p.push('it added a cap in another unit')
  if (c.weeklyCapEth != null || c.weeklyCapUsd != null) p.push('it added a weekly cap the published rules do not have')
  const saved = (Array.isArray(c.savedAddresses) ? c.savedAddresses : []).map(addr)
  const want = new Set(r.vendors)
  if (saved.length !== want.size || saved.some((a: Address | null) => !a || !want.has(a))) p.push(`saved addresses are [${saved.join(', ')}], not exactly the vendors`)
  const actions: unknown[] = Array.isArray(c.allowedActions) ? c.allowedActions : []
  if (actions.length !== 1 || actions[0] !== 'transfer') p.push(`allowed actions are [${actions.join(', ')}], not only transfer`)
  const tokens: unknown[] = Array.isArray(c.allowedTokens) ? c.allowedTokens : []
  if (tokens.some(t => String(t).toUpperCase() !== unitName(r.asset))) p.push(`allowed tokens are [${tokens.join(', ')}], not only ${unitName(r.asset)}`)
  if (c.ownContracts != null && !(Array.isArray(c.ownContracts) && c.ownContracts.length === 0)) p.push('it lets the agent call contracts')
  const unknown = Object.keys(c).filter(k => !KNOWN_FIELDS.has(k))
  if (unknown.length) p.push(`it has fields setup does not know: ${unknown.join(', ')}`)
  if (c.targetAllocation != null) p.push('it added a target allocation')
  if (Array.isArray(c.unresolved) && c.unresolved.length) p.push(`the compiler could not turn these into rules: ${c.unresolved.join('; ')}`)
  if (c.strictness === 'lenient') p.push('strictness is lenient')
  return p
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

  const rules = publishedRules(cfg.vendors, cfg.asset, cfg.maxPerPayment ?? (cfg.asset === 'eth' ? '0.0005' : '5'), env.DEMO_DAILY_CAP ?? (cfg.asset === 'eth' ? '0.005' : '50'))
  const { compiled, shownToOwner } = await compileMandate(cfg.saysoApi, rules.text)
  console.log(`\nthe published rules:\n  "${rules.text}"\n\nsayso compiled them as:\n${JSON.stringify(compiled, null, 2)}\n\nsayso's summary for the owner:\n${shownToOwner}\n`)
  const problems = compiledProblems(compiled, rules)
  if (problems.length) throw new Error(`the compiled rules are not the published ones, so nothing was signed:\n- ${problems.join('\n- ')}`)
  if (!(await confirmed())) throw new Error('not confirmed; nothing was registered or signed')

  const opts = { chainId: cfg.chainId, ...(env.DEMO_INVITE ? { invite: env.DEMO_INVITE } : {}) }
  const { apiKey } = await registerWallet(cfg.saysoApi, providerSigner(agent as any), owner.address, opts as any)
  await setMandate(cfg.saysoApi, owner, agent.address, rules.text, { ...compiled, summary: rules.text }, opts as any)
  await setCheckMode(cfg.saysoApi, owner, agent.address, 'enforce', opts as any)
  mkdirSync(cfg.dataDir, { recursive: true })
  const file = join(cfg.dataDir, 'sayso-api-key')
  writeFileSync(file, `${apiKey}\n`, { mode: 0o600 })
  console.log(`done: ${agent.address} registered, rules signed, enforce on. API key written to ${file} (put it in DEMO_SAYSO_API_KEY on the box).`)
}

if (import.meta.main) main().catch(e => { console.error(`setup failed: ${(e as Error).message}`); process.exit(1) })
