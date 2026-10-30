// What the agent's wallet may do. setup has sayso compile the published rules below, the owner signs them as the
// mandate, and setup writes what was signed to signed-rules.json. saysoio 0.7.0 has no call that reads a signed mandate
// back, so the box shows that file; on base-sepolia without it, the rules rebuilt from its settings ("published rules").
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SDK_VERSION } from 'saysoio'
import { getAddress, parseUnits, type Address, type Hex } from 'viem'
import { decimalsFor, defaultSaysoApi, unitName, type Asset, type Config, type Network, type Vendor } from './config.ts'

export interface Published { text: string; vendors: Address[]; max: string; daily: string; weekly: string; asset: Asset }

/** sayso's compiler may read the closing sentence as strict; setup accepts strict or normal, never lenient. */
export function publishedRules(vendors: Vendor[], asset: Asset, max: string, daily: string, weekly: string): Published {
  const unit = unitName(asset)
  const list = vendors.map(v => `${v.name} (${v.address})`).join(', ')
  const text = `The agent pays vendor invoices in ${unit} to these vendors: ${list}. Each payment is at most ${max} ${unit}, `
    + `and payments total at most ${daily} ${unit} a day and ${weekly} ${unit} a week. The agent makes plain ${unit} transfers `
    + `to these vendors; it does not trade other tokens, call contracts, approve spending or sign messages.`
  return { text, vendors: vendors.map(v => v.address), max, daily, weekly, asset }
}

/** The per-payment cap setup signs: DEMO_MAX_PER_PAYMENT, or its default for the asset. */
export const perPaymentCap = (cfg: Pick<Config, 'maxPerPayment' | 'asset'>) => cfg.maxPerPayment ?? (cfg.asset === 'eth' ? '0.0005' : '5')

/** What setup writes next to the API key once the owner has signed: the box shows these rules, and refuses to start
 *  when its own settings say something else. Nothing in it is secret. */
export interface SignedRules {
  text: string; vendors: { name: string; address: Address }[]; max: string; daily: string; weekly: string
  asset: Asset; network: Network; strictness: 'strict' | 'normal'; mandateId: Hex | null; mandateHash: Hex | null; signedAt: string
}

export const SIGNED_RULES_FILE = 'signed-rules.json'

/** strictness when no signed-rules file is there (base-sepolia only): what sayso compiled on 31 Oct */
const FALLBACK_STRICTNESS = 'strict'

const DECIMAL = /^\d+(\.\d+)?$/
const HEX32 = /^0x[0-9a-fA-F]{64}$/

/** The file's content checked field by field; anything off throws, naming the field. */
export function parseSignedRules(raw: unknown): SignedRules {
  const o = (raw ?? {}) as Record<string, unknown>
  const bad = (f: string) => new Error(`${SIGNED_RULES_FILE}: bad ${f}`)
  const str = (f: string) => { if (typeof o[f] !== 'string' || !o[f]) throw bad(f); return o[f] as string }
  const dec = (f: string) => { const v = str(f); if (!DECIMAL.test(v)) throw bad(f); return v }
  const hex = (f: string) => { if (o[f] == null) return null; if (typeof o[f] !== 'string' || !HEX32.test(o[f] as string)) throw bad(f); return o[f] as Hex }
  if (!Array.isArray(o.vendors) || !o.vendors.length) throw bad('vendors')
  const vendors = o.vendors.map((v: any) => {
    if (typeof v?.name !== 'string' || typeof v?.address !== 'string') throw bad('vendors')
    try { return { name: v.name, address: getAddress(v.address) } } catch { throw bad('vendors') }
  })
  const asset = str('asset'), network = str('network'), strictness = str('strictness'), signedAt = str('signedAt')
  if (asset !== 'eth' && asset !== 'usdc') throw bad('asset')
  if (network !== 'base' && network !== 'base-sepolia') throw bad('network')
  if (strictness !== 'strict' && strictness !== 'normal') throw bad('strictness')
  if (Number.isNaN(Date.parse(signedAt))) throw bad('signedAt')
  return { text: str('text'), vendors, max: dec('max'), daily: dec('daily'), weekly: dec('weekly'), asset, network, strictness, mandateId: hex('mandateId'), mandateHash: hex('mandateHash'), signedAt }
}

/** The file in the data folder, or null when there is none. */
export function readSignedRules(dataDir: string): SignedRules | null {
  let text: string
  try { text = readFileSync(join(dataDir, SIGNED_RULES_FILE), 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(`${SIGNED_RULES_FILE} is not JSON`) }
  return parseSignedRules(raw)
}

const sameAmount = (a: string, b: string, asset: Asset) => parseUnits(a, decimalsFor(asset)) === parseUnits(b, decimalsFor(asset))

/** Where the box's settings differ from what the owner signed (empty when they agree). */
export function signedRulesProblems(s: SignedRules, cfg: Config): string[] {
  const p: string[] = []
  if (s.network !== cfg.network) p.push(`signed for ${s.network}, the box runs on ${cfg.network}`)
  if (s.asset !== cfg.asset) p.push(`signed for ${s.asset}, DEMO_ASSET is ${cfg.asset}`)
  else if (!sameAmount(s.max, perPaymentCap(cfg), cfg.asset)) p.push(`signed per-payment cap ${s.max}, DEMO_MAX_PER_PAYMENT gives ${perPaymentCap(cfg)}`)
  const key = (v: { name: string; address: string }) => `${v.name}=${v.address}`
  const signed = new Set(s.vendors.map(key)), mine = new Set(cfg.vendors.map(key))
  if (signed.size !== mine.size || [...mine].some(v => !signed.has(v))) p.push('DEMO_VENDORS is not the signed vendor list')
  return p
}

/** The rules the box shows: the signed file, or on base-sepolia only, the published rules rebuilt from its settings. */
export function loadRules(cfg: Config): SignedRules | null {
  const s = readSignedRules(cfg.dataDir)
  if (!s) {
    if (cfg.network === 'base') throw new Error(`no ${SIGNED_RULES_FILE} in ${cfg.dataDir}: copy the one setup wrote (deploy/README.md, step 5)`)
    return null
  }
  const p = signedRulesProblems(s, cfg)
  if (p.length) throw new Error(`the settings differ from ${SIGNED_RULES_FILE}:\n- ${p.join('\n- ')}`)
  return s
}

export function rulesView(cfg: Config, signed: SignedRules | null) {
  const r = signed ?? { ...publishedRules(cfg.vendors, cfg.asset, perPaymentCap(cfg), cfg.caps.daily, cfg.caps.weekly), strictness: FALLBACK_STRICTNESS, signedAt: null }
  return {
    source: signed ? 'signed rules' : 'published rules', signedAt: r.signedAt, text: r.text, unit: unitName(cfg.asset), network: cfg.network,
    vendors: (signed?.vendors ?? cfg.vendors).map(v => ({ name: v.name, address: v.address })),
    perPayment: r.max, daily: r.daily, weekly: r.weekly, actions: ['transfer'], strictness: r.strictness,
    sdk: { name: 'saysoio', version: SDK_VERSION, mode: 'enforce' },
    // named only when it is sayso's own server for the network: a custom DEMO_SAYSO_API stays on the box
    checkServer: cfg.saysoApi === defaultSaysoApi(cfg.network) ? new URL(cfg.saysoApi).origin : null, signedVerdicts: true,
  }
}
