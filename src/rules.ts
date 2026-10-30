// What the agent's wallet may do. setup has sayso compile the published rules below and the owner signs them as the
// mandate. saysoio 0.7.0 has no call that reads a signed mandate back, so the page is shown these rules rebuilt from
// the same settings setup signs, and says so ("published rules").
import { SDK_VERSION } from 'saysoio'
import { unitName, type Asset, type Config, type Vendor } from './config.ts'
import type { Address } from 'viem'

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

/** what sayso compiled the published rules as when the owner signed them (31 Oct) */
export const STRICTNESS = 'strict'

export function rulesView(cfg: Config) {
  const r = publishedRules(cfg.vendors, cfg.asset, perPaymentCap(cfg), cfg.caps.daily, cfg.caps.weekly)
  return {
    source: 'published rules', text: r.text, unit: unitName(cfg.asset), network: cfg.network,
    vendors: cfg.vendors.map(v => ({ name: v.name, address: v.address })),
    perPayment: r.max, daily: r.daily, weekly: r.weekly, actions: ['transfer'], strictness: STRICTNESS,
    sdk: { name: 'saysoio', version: SDK_VERSION, mode: 'enforce' },
    // the origin only: a path or query on DEMO_SAYSO_API stays on the box
    checkServer: new URL(cfg.saysoApi).origin, signedVerdicts: true,
  }
}
