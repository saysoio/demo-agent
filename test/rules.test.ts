import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config.ts'
import { loadRules, parseSignedRules, perPaymentCap, publishedRules, readSignedRules, rulesView, SIGNED_RULES_FILE, signedRulesProblems } from '../src/rules.ts'
import { signedRecord } from '../src/setup.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'demo-rules-'))
const cfgFor = (env: Record<string, string> = {}) => loadConfig({ DEMO_FAKE: '1', DEMO_DATA_DIR: dir(), ...env })
const ID = `0x${'ab'.repeat(32)}` as const

function recordFor(cfg: ReturnType<typeof cfgFor>, strictness = 'normal') {
  const r = publishedRules(cfg.vendors, cfg.asset, perPaymentCap(cfg), '0.004', '0.01')
  return signedRecord(r, cfg.vendors, cfg.network, { strictness, summary: r.text }, ID, new Date('2026-10-31T12:00:00Z'))
}
const write = (cfg: ReturnType<typeof cfgFor>, rec: unknown) => writeFileSync(join(cfg.dataDir, SIGNED_RULES_FILE), JSON.stringify(rec))

test('what setup writes reads back as it was, with the hash of the signed rules', () => {
  const cfg = cfgFor(), rec = recordFor(cfg)
  assert.match(rec.mandateHash!, /^0x[0-9a-f]{64}$/)
  assert.deepEqual(parseSignedRules(JSON.parse(JSON.stringify(rec))), rec)
  assert.throws(() => signedRecord(publishedRules(cfg.vendors, 'eth', '1', '1', '1'), cfg.vendors, 'base-sepolia', { strictness: 'lenient' }, null, new Date()), /strictness/)
})

test('a malformed file is refused by field', () => {
  const rec = recordFor(cfgFor())
  for (const [k, v] of [['max', '1e3'], ['asset', 'btc'], ['strictness', 'lenient'], ['vendors', []], ['mandateId', '0x12'], ['signedAt', 'yesterday']] as const) {
    assert.throws(() => parseSignedRules({ ...rec, [k]: v }), new RegExp(`bad ${k}`), k)
  }
  assert.equal(parseSignedRules({ ...rec, mandateId: null }).mandateId, null)
})

test('no file: published rules on base-sepolia, a refusal to start on base', () => {
  const cfg = cfgFor()
  assert.equal(readSignedRules(cfg.dataDir), null)
  assert.equal(loadRules(cfg), null)
  const view = rulesView(cfg, null)
  assert.equal(view.source, 'published rules')
  assert.equal(view.strictness, 'strict')
  assert.throws(() => loadRules(cfgFor({ DEMO_NETWORK: 'base', DEMO_MAX_PER_PAYMENT: '5' })), /no signed-rules\.json/)
  const broken = cfgFor(); writeFileSync(join(broken.dataDir, SIGNED_RULES_FILE), '{not json')
  assert.throws(() => loadRules(broken), /not JSON/)
})

test('the box shows the signed file, strictness and caps included', () => {
  const cfg = cfgFor()
  write(cfg, recordFor(cfg))
  const s = loadRules(cfg)!
  const view = rulesView(cfg, s)
  assert.equal(view.source, 'signed rules')
  assert.equal(view.strictness, 'normal')
  assert.deepEqual([view.daily, view.weekly], ['0.004', '0.01'])
  assert.equal(view.signedAt, '2026-10-31T12:00:00.000Z')
})

test('settings that differ from the signed file stop the start', () => {
  const cfg = cfgFor(), rec = recordFor(cfg)
  assert.deepEqual(signedRulesProblems(rec, cfg), [])
  assert.match(signedRulesProblems(rec, cfgFor({ DEMO_MAX_PER_PAYMENT: '0.001' })).join(), /per-payment cap 0\.0005/)
  assert.deepEqual(signedRulesProblems(rec, cfgFor({ DEMO_MAX_PER_PAYMENT: '0.00050' })), [])
  assert.match(signedRulesProblems({ ...rec, vendors: rec.vendors.slice(1) }, cfg).join(), /DEMO_VENDORS/)
  assert.match(signedRulesProblems({ ...rec, vendors: [{ ...rec.vendors[0], name: 'Other Co' }, rec.vendors[1]] }, cfg).join(), /DEMO_VENDORS/)
  assert.match(signedRulesProblems({ ...rec, asset: 'usdc' }, cfg).join(), /DEMO_ASSET/)
  const off = cfgFor({ DEMO_MAX_PER_PAYMENT: '0.001' }); write(off, rec)
  assert.throws(() => loadRules(off), /settings differ/)
})

test('the check server is named only when it is sayso\'s own for the network', () => {
  assert.equal(rulesView(cfgFor(), null).checkServer, 'https://sepolia.saysoio.com')
  assert.equal(rulesView(cfgFor({ DEMO_SAYSO_API: 'https://sayso.internal.example/v1' }), null).checkServer, null)
})
