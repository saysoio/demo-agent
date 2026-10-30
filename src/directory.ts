// Who is who at the company: each vendor's official identities and the colleagues in the team chat. One list, made from
// the vendor book in the settings: the agent's prompt, the scheduled vendor invoices and the page all read it. Every
// domain is under .example (reserved, RFC 2606) and every X handle ends in _demo, so nothing points at a real company.
import type { Vendor } from './config.ts'
import { slug } from './guard/text.ts'

export interface VendorEntry {
  name: string
  /** the address its invoices come from */
  email: string
  website: string
  /** its account on X, with the @ */
  x: string
  wallet: string
  usual: string
}
export interface Colleague { name: string; role: string; chat: string }
export interface Directory { vendors: VendorEntry[]; colleagues: Colleague[] }

export const COLLEAGUES: readonly Colleague[] = [
  { name: 'Dana Okafor', role: 'CFO', chat: '@dana' },
  { name: 'Marcus Lindqvist', role: 'Head of Operations', chat: '@marcus' },
  { name: 'Priya Raman', role: 'Office Manager', chat: '@priya' },
]

/** "Name <email>", the form a vendor's mail and invoices are sent from. */
export const mailbox = (v: Pick<VendorEntry, 'name' | 'email'>) => `${v.name} <${v.email}>`

export function directory(vendors: readonly Vendor[]): Directory {
  const taken = new Set<string>()
  return {
    vendors: vendors.map((v, i) => {
      const s = slug(v.name) || `vendor_${i + 1}`
      const domain = `${s.replace(/_/g, '-')}.example`
      // X allows 15 characters: the first word, cut to 10, then _demo; a repeat gets a number
      let x = `${s.split('_')[0].slice(0, 10)}_demo`
      if (taken.has(x)) x = `${s.split('_')[0].slice(0, 9)}${i + 1}_demo`
      taken.add(x)
      return { name: v.name, email: `billing@${domain}`, website: domain, x: `@${x}`, wallet: v.address, usual: v.usual }
    }),
    colleagues: COLLEAGUES.map(c => ({ ...c })),
  }
}
