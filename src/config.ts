// Settings from the environment, read once at start. Secrets are read here and handed to the module that needs them;
// nothing else reads process.env.
import { isIP } from 'node:net'
import { formatUnits, getAddress, parseUnits, type Address } from 'viem'

export type Asset = 'eth' | 'usdc'
export type Network = 'base-sepolia' | 'base'

export interface Vendor { name: string; address: Address; usual: string }

export const MODEL = 'claude-haiku-5-5'
/** the model's API when no gateway is set; always passed, so ANTHROPIC_BASE_URL in the environment cannot reroute it */
export const ANTHROPIC_API = 'https://api.anthropic.com'

export const decimalsFor = (asset: Asset) => (asset === 'eth' ? 18 : 6)
export const unitName = (asset: Asset) => (asset === 'eth' ? 'ETH' : 'USDC')

export interface LlmSettings {
  model: string
  /** an API gateway or reverse proxy that speaks the Anthropic API, in place of api.anthropic.com */
  baseUrl: string | null
  /** a forward HTTP(S) proxy for the model's traffic only; may hold user:pass, so it is a secret */
  proxy: string | null
}

export interface Config {
  network: Network
  chainId: number
  asset: Asset
  /** checksummed token contract for usdc, null for eth */
  token: Address | null
  explorer: string
  rpcUrl: string
  saysoApi: string
  vendors: Vendor[]
  port: number
  host: string
  dataDir: string
  tickMs: number
  vendorInvoiceEveryMs: number
  /** ceiling on the fee per gas, in gwei; also sets saysoio's fee bounds (src/wallet.ts `feeBounds`) */
  maxFeeGwei: string
  /** the signed per-payment cap as text, in the asset's unit (required on base): an allow above it pauses the game */
  maxPerPayment: string | null
  /** the daily and weekly caps setup signs (DEMO_DAILY_CAP, DEMO_WEEKLY_CAP), shown on the page as part of the rules */
  caps: { daily: string; weekly: string }
  /** the public repo behind "Read the code"; https only, null hides the link */
  sourceUrl: string | null
  /** prices per million tokens in USD, and the daily budget (UTC) that pauses the game when reached; null for none */
  spend: { inPerMtok: number; outPerMtok: number; budgetUsd: number | null }
  agentName: string
  fake: boolean
  dev: boolean
  llm: LlmSettings
  trustLocalHeader: string | null
  /** exact peer addresses, besides loopback, whose trustLocalHeader is believed */
  trustedProxies: string[]
  limits: { perHandleHour: number; perIpHour: number; perIpDay: number; perMinute: number; modelCallsDay: number; queueMax: number }
  secrets: { anthropic: string; sayso: string; admin: string; cdp: { apiKeyId: string; apiKeySecret: string; walletSecret: string } | null }
  cdpAccountName: string
}

const NETWORKS: Record<Network, { chainId: number; explorer: string; publicRpc: string; saysoApi: string; usdc: Address | null }> = {
  // Sepolia: sayso's test server understands ETH transfers only (apps/api/src/chains/index.ts), so tokens lean to "ask"
  'base-sepolia': { chainId: 84532, explorer: 'https://sepolia.basescan.org', publicRpc: 'https://sepolia.base.org', saysoApi: 'https://sepolia.saysoio.com', usdc: null },
  // native USDC on Base, from ETHSKILLS addresses; verify with `cast code` before funding
  base: { chainId: 8453, explorer: 'https://basescan.org', publicRpc: 'https://mainnet.base.org', saysoApi: 'https://api.saysoio.com', usdc: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') },
}

/** sayso's own server for the network, the one the page may name */
export const defaultSaysoApi = (network: Network) => NETWORKS[network].saysoApi

/** DEMO_VENDORS: `Name=0xAddress=usual amount;…`. Every vendor address must be a wallet we control. */
export function parseVendors(v: string | undefined): Vendor[] {
  if (!v?.trim()) return []
  return v.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const [name, addr, usual] = s.split('=').map(x => x?.trim())
    if (!name || !/^[A-Za-z0-9 .&-]{2,40}$/.test(name)) throw new Error(`DEMO_VENDORS: bad vendor name in "${s}"`)
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`DEMO_VENDORS: bad address for ${name}`)
    if (!usual || !/^\d+(\.\d+)?$/.test(usual)) throw new Error(`DEMO_VENDORS: bad usual amount for ${name}`)
    return { name, address: getAddress(addr), usual }
  })
}

// Errors name the setting, never its value: the proxy URL may carry a password.
function urlSetting(env: Record<string, string | undefined>, name: string, schemes: string[], o: { credentials: boolean }): string | null {
  const v = env[name]?.trim()
  if (!v) return null
  let u: URL
  try { u = new URL(v) } catch { throw new Error(`${name} is not a valid URL`) }
  if (!schemes.includes(u.protocol)) throw new Error(`${name} must start with ${schemes.map(s => `${s}//`).join(' or ')}`)
  if (!o.credentials && (u.username || u.password)) throw new Error(`${name} must not hold credentials`)
  return v.replace(/\/$/, '')
}

/** DEMO_TRUSTED_PROXY: comma-separated exact IP addresses (no ranges). */
export function parseTrustedProxies(v: string | undefined): string[] {
  return (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(a => {
    if (!isIP(a)) throw new Error(`DEMO_TRUSTED_PROXY: "${a}" is not an IP address`)
    return a
  })
}

export function parseLlm(env: Record<string, string | undefined>, dev: boolean): LlmSettings {
  const model = env.DEMO_LLM_MODEL?.trim() || MODEL
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model)) throw new Error('DEMO_LLM_MODEL must be a plain model id (letters, digits, . _ -)')
  return {
    model,
    baseUrl: urlSetting(env, 'DEMO_LLM_BASE_URL', dev ? ['https:', 'http:'] : ['https:'], { credentials: false }),
    proxy: urlSetting(env, 'DEMO_LLM_PROXY', ['http:', 'https:'], { credentials: true }),
  }
}

/** DEMO_MAX_PER_PAYMENT: a plain decimal in the asset's unit; on base the real pot needs it. */
export function parseMaxPerPayment(v: string | undefined, network: Network): string | null {
  const x = v?.trim()
  if (!x) {
    if (network === 'base') throw new Error('DEMO_MAX_PER_PAYMENT is required on base: set it to the signed per-payment cap')
    return null
  }
  if (!/^\d+(\.\d+)?$/.test(x)) throw new Error('DEMO_MAX_PER_PAYMENT must be a plain decimal')
  return x
}

/** A cap setting: a positive decimal in the asset's unit, or the fallback when unset or empty. The error names the setting only. */
function capSetting(name: string, v: string | undefined, fallback: () => string, asset: Asset): string {
  const s = v?.trim() || fallback()
  const dec = decimalsFor(asset)
  if (!/^\d+(\.\d+)?$/.test(s) || (s.split('.')[1]?.length ?? 0) > dec || parseUnits(s, dec) === 0n) throw new Error(`${name} must be a positive decimal in ${unitName(asset)} with at most ${dec} decimals`)
  return s
}

/** DEMO_DAILY_CAP and DEMO_WEEKLY_CAP (three times the daily cap by default); the week holds at least a day. */
export function caps(env: Record<string, string | undefined>, asset: Asset): { daily: string; weekly: string } {
  const dec = decimalsFor(asset)
  const daily = capSetting('DEMO_DAILY_CAP', env.DEMO_DAILY_CAP, () => (asset === 'eth' ? '0.005' : '50'), asset)
  const weekly = capSetting('DEMO_WEEKLY_CAP', env.DEMO_WEEKLY_CAP, () => formatUnits(parseUnits(daily, dec) * 3n, dec), asset)
  if (parseUnits(weekly, dec) < parseUnits(daily, dec)) throw new Error('DEMO_WEEKLY_CAP must be at least DEMO_DAILY_CAP')
  return { daily, weekly }
}

/** A price or budget in USD: a plain decimal, or the fallback when unset or empty. */
function usdSetting(env: Record<string, string | undefined>, name: string, fallback: number | null): number | null {
  const v = env[name]?.trim()
  if (!v) return fallback
  if (!/^\d{1,9}(\.\d{1,9})?$/.test(v)) throw new Error(`${name} must be a plain decimal in USD`)
  return Number(v)
}

/** DEMO_LLM_PRICE_IN_PER_MTOK and _OUT_ (claude-haiku-5-5 by default) and DEMO_LLM_BUDGET_USD, a daily budget (UTC). */
export function parseSpend(env: Record<string, string | undefined>): Config['spend'] {
  const budgetUsd = usdSetting(env, 'DEMO_LLM_BUDGET_USD', null)
  if (budgetUsd === 0) throw new Error('DEMO_LLM_BUDGET_USD must be above 0; leave it empty for no budget')
  return { inPerMtok: usdSetting(env, 'DEMO_LLM_PRICE_IN_PER_MTOK', 0.1)!, outPerMtok: usdSetting(env, 'DEMO_LLM_PRICE_OUT_PER_MTOK', 0.5)!, budgetUsd }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const int = (n: string, d: number) => { const x = Number(env[n] ?? d); if (!Number.isInteger(x) || x <= 0) throw new Error(`${n} must be a positive whole number`); return x }
  const network = (env.DEMO_NETWORK ?? 'base-sepolia') as Network
  const net = NETWORKS[network]
  if (!net) throw new Error(`DEMO_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`)
  const asset = (env.DEMO_ASSET ?? (network === 'base' ? 'usdc' : 'eth')) as Asset
  if (asset !== 'eth' && asset !== 'usdc') throw new Error('DEMO_ASSET must be eth or usdc')
  if (asset === 'usdc' && !net.usdc) throw new Error(`no USDC on ${network} that sayso understands; use DEMO_ASSET=eth`)
  const fake = env.DEMO_FAKE === '1'
  const dev = env.DEMO_DEV === '1'
  const need = (n: string) => { const x = env[n]?.trim(); if (!x && !fake) throw new Error(`missing ${n}`); return x ?? '' }
  const vendors = parseVendors(env.DEMO_VENDORS)
  if (!vendors.length && !fake) throw new Error('DEMO_VENDORS is empty')
  const cdp = fake ? null : { apiKeyId: need('CDP_API_KEY_ID'), apiKeySecret: need('CDP_API_KEY_SECRET'), walletSecret: need('CDP_WALLET_SECRET') }
  const admin = env.DEMO_ADMIN_TOKEN?.trim() ?? ''
  if (!fake && admin.length < 32) throw new Error('DEMO_ADMIN_TOKEN must be at least 32 characters')
  const maxPerPayment = parseMaxPerPayment(env.DEMO_MAX_PER_PAYMENT, network)
  return {
    network, chainId: net.chainId, asset, token: asset === 'usdc' ? net.usdc : null, explorer: net.explorer,
    rpcUrl: env.DEMO_RPC_URL?.trim() || net.publicRpc,
    saysoApi: (env.DEMO_SAYSO_API?.trim() || net.saysoApi).replace(/\/$/, ''),
    vendors: vendors.length ? vendors : FAKE_VENDORS,
    port: int('DEMO_PORT', 8787), host: env.DEMO_HOST ?? '127.0.0.1', dataDir: env.DEMO_DATA_DIR ?? 'data',
    tickMs: int('DEMO_TICK_MS', 3000), vendorInvoiceEveryMs: int('DEMO_VENDOR_INVOICE_EVERY_MS', 20 * 60_000),
    maxFeeGwei: /^\d+(\.\d+)?$/.test(env.DEMO_MAX_FEE_GWEI ?? '') ? env.DEMO_MAX_FEE_GWEI! : '1',
    maxPerPayment, caps: caps(env, asset), sourceUrl: urlSetting(env, 'DEMO_SOURCE_URL', ['https:'], { credentials: false }),
    spend: parseSpend(env), agentName: env.DEMO_AGENT_NAME?.trim() || 'Penny',
    fake, dev, llm: parseLlm(env, dev),
    trustLocalHeader: env.DEMO_TRUST_LOCAL_HEADER?.trim().toLowerCase() || null,
    trustedProxies: parseTrustedProxies(env.DEMO_TRUSTED_PROXY),
    limits: {
      perHandleHour: int('DEMO_LIMIT_HANDLE_HOUR', 10), perIpHour: int('DEMO_LIMIT_IP_HOUR', 30), perIpDay: int('DEMO_LIMIT_IP_DAY', 120),
      perMinute: int('DEMO_LIMIT_PER_MINUTE', 20), modelCallsDay: int('DEMO_MODEL_CALLS_DAY', 3000), queueMax: int('DEMO_QUEUE_MAX', 50),
    },
    secrets: { anthropic: need('ANTHROPIC_API_KEY'), sayso: need('DEMO_SAYSO_API_KEY'), admin: admin || 'dev-admin-token-not-for-production', cdp },
    cdpAccountName: env.DEMO_CDP_ACCOUNT ?? 'sayso-demo-agent',
  }
}

const FAKE_VENDORS: Vendor[] = [
  { name: 'Northwind Hosting', address: getAddress('0x1111111111111111111111111111111111111111'), usual: '0.0002' },
  { name: 'Lantern Design', address: getAddress('0x2222222222222222222222222222222222222222'), usual: '0.0003' },
]
