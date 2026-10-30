import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { parseEther } from 'viem'
import { Agent } from '../src/agent.ts'
import { FakeBrain } from '../src/brain.ts'
import { loadConfig } from '../src/config.ts'
import { makeServer } from '../src/server.ts'
import { BUDGET_PAUSE } from '../src/spend.ts'
import { Store } from '../src/store.ts'
import { FakePayer } from '../src/wallet.ts'

const ADMIN = 'a'.repeat(40)
const cfg = loadConfig({ DEMO_FAKE: '1', DEMO_DEV: '1', DEMO_ADMIN_TOKEN: ADMIN, DEMO_LIMIT_IP_HOUR: '6' })
const store = new Store(':memory:')
const payer = new FakePayer(cfg.vendors, s => parseEther(s), parseEther('0.01'))
const agent = new Agent({ store, brain: new FakeBrain(cfg.vendors), payer, asset: 'eth', vendors: cfg.vendors })
let clock = Date.now()
const server = makeServer({ cfg, store, agent, payer, now: () => clock })
let url = ''

before(async () => { await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r())); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
after(() => { server.close(); store.close() })

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('submit queues a cleaned item; bad input is refused', async () => {
  const ok = await post('/api/submit', { channel: 'email', from: 'billing@northwind-hosting.example', text: 'please pay me' })
  assert.equal(ok.status, 202)
  const { id } = await ok.json() as any
  const { items } = await (await fetch(`${url}/api/feed?ids=${id}`)).json() as any
  assert.equal(items[0].from, 'billing@northwind-hosting.example')
  assert.equal('handle' in items[0], false)
  // a page from before handles were dropped still sends one: it is ignored, whatever it says
  for (const handle of ['mallory', 'sayso', 'northwind_ops']) assert.equal((await post('/api/submit', { handle, channel: 'email', from: 'a@b.example', text: 'hi' })).status, 202, handle)
  // a page from before senders: refused with a message that tells the player to reload
  const old = await post('/api/submit', { channel: 'email', text: 'no sender' })
  assert.equal(old.status, 400)
  assert.match((await old.json() as any).error, /reload/i)
  assert.equal((await post('/api/submit', { channel: 'post', from: 'billing@northwind-hosting.example', text: 'x' })).status, 400)
  assert.equal((await post('/api/submit', { channel: 'fax', text: 'x' })).status, 400)
  assert.equal((await post('/api/submit', { channel: 'email', from: 'billing@northwind-hosting.example', text: '' })).status, 400)
  const notJson = await fetch(url + '/api/submit', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' })
  assert.equal(notJson.status, 400)
  const huge = await post('/api/submit', { channel: 'email', from: 'billing@northwind-hosting.example', text: 'x'.repeat(50_000) })
  assert.equal(huge.status, 413)
  assert.equal(huge.headers.get('connection'), 'close')
  assert.deepEqual(await huge.json(), { error: 'too large' })
})

test('a network runs out of tries for the hour, whatever sender or old handle it uses', async () => {
  // the first test sent 4 from this address; the hour allows 6
  for (let i = 0; i < 2; i++) assert.equal((await post('/api/submit', { channel: 'post', from: `@eve_${i}`, text: `try ${i}` })).status, 202)
  const r = await post('/api/submit', { handle: `fresh_${Date.now()}`, channel: 'post', from: '@someone_new', text: 'one more' })
  assert.equal(r.status, 429)
  assert.match((await r.json() as any).error, /network/)
  assert.ok(r.headers.get('retry-after'))
  clock += 3600_001
})

test('the feed never shows the IP, and hidden rows are left out', async () => {
  const { items } = await (await fetch(url + '/api/feed')).json() as any
  assert.ok(items.length > 0)
  for (const a of items) { assert.equal('ipKey' in a, false); assert.equal('hidden' in a, false) }
  const id = items[0].id
  assert.equal((await post('/api/admin/hide', { id }, { authorization: `Bearer ${ADMIN}` })).status, 200)
  const again = await (await fetch(url + '/api/feed')).json() as any
  assert.equal(again.items.some((a: any) => a.id === id), false)
})

test('the feed follows rows by id, leaving hidden ones out', async () => {
  const a = store.add({ source: 'player', ipKey: 'ip', channel: 'post', body: 'one' })
  const b = store.add({ source: 'player', ipKey: 'ip', channel: 'post', body: 'two' })
  store.hide(b, true)
  const { items } = await (await fetch(`${url}/api/feed?ids=${a},${b}`)).json() as any
  assert.deepEqual(items.map((x: any) => x.id), [a])
  assert.equal('ipKey' in items[0], false)
  assert.equal((await fetch(`${url}/api/feed?ids=1,x`)).status, 400)
})

test('the pot names the explorer and the page limits', async () => {
  const pot = await (await fetch(url + '/api/pot')).json() as any
  assert.equal(pot.explorerBase, cfg.explorer)
  assert.deepEqual(pot.limits, { textChars: 600, feedPage: 50 })
})

test('the rules name the vendors, the three caps, the SDK and the check server, and are cacheable', async () => {
  const r = await fetch(url + '/api/rules')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('cache-control')!, /max-age=300/)
  const rules = await r.json() as any
  assert.equal(rules.source, 'published rules')
  assert.deepEqual(rules.vendors.map((v: any) => v.address), cfg.vendors.map(v => v.address))
  assert.deepEqual([rules.perPayment, rules.daily, rules.weekly], ['0.0005', '0.005', '0.015'])
  assert.deepEqual(rules.actions, ['transfer'])
  assert.equal(rules.strictness, 'strict')
  assert.deepEqual(rules.sdk, { name: 'saysoio', version: '0.7.0', mode: 'enforce' })
  assert.equal(rules.checkServer, 'https://sepolia.saysoio.com')
  assert.equal(rules.signedVerdicts, true)
  assert.ok(rules.text.includes(cfg.vendors[0].address))
  assert.doesNotMatch(JSON.stringify(rules), /dev-admin|apiKey|secret/i)
})

test('the stopped tricks show an excerpt, the payee, the amount and sayso\'s rule, never the IP', async () => {
  const id = store.add({ source: 'player', ipKey: 'ip', channel: 'chat', body: `CFO here. ${'urgent '.repeat(40)}` })
  store.finish(id, { action: 'pay', toAddr: '0x9999999999999999999999999999999999999999', amount: '0.001', memo: 'm', thought: 't', verdict: 'block', reason: 'unknown payee', rule: 'unknown payee', outcome: 'blocked', note: null, txHash: null, checkMs: 5, win: false })
  const { items } = await (await fetch(url + '/api/tricks')).json() as any
  assert.equal(items[0].id, id)
  assert.equal('handle' in items[0], false)
  assert.equal(items[0].rule, 'unknown payee')
  assert.ok(items[0].excerpt.startsWith('CFO here.') && items[0].excerpt.endsWith('…'))
  for (const k of ['ipKey', 'body', 'thought', 'hidden']) assert.equal(k in items[0], false, k)
  store.hide(id, true)
  const fresh = async () => ((await (await fetch(url + '/api/tricks')).json()) as any).items.some((a: any) => a.id === id)
  assert.equal(await fresh(), true, 'shared for a few seconds')
  clock += 5_000
  assert.equal(await fresh(), false)
})

test('the directory names each vendor\'s identities and the colleagues, and nothing else', async () => {
  const r = await fetch(url + '/api/directory')
  assert.equal(r.status, 200)
  const d = await r.json() as any
  assert.deepEqual(Object.keys(d), ['vendors', 'colleagues'])
  assert.equal(d.vendors.length, cfg.vendors.length)
  assert.deepEqual(Object.keys(d.vendors[0]), ['name', 'email', 'website', 'x', 'wallet', 'usual'])
  assert.equal(d.vendors[0].wallet, cfg.vendors[0].address)
  assert.ok(d.vendors.every((v: any) => v.email.endsWith('.example') && v.x.endsWith('_demo')))
  assert.deepEqual(Object.keys(d.colleagues[0]), ['name', 'role', 'chat'])
})

test('the pot names no source until DEMO_SOURCE_URL is set', async () => {
  const pot = await (await fetch(url + '/api/pot')).json() as any
  assert.equal(pot.source, null)
  assert.equal('source' in pot, true)
})

test('admin calls need the token; pause stops submissions', async () => {
  assert.equal((await post('/api/admin/pause', { paused: true }, { authorization: `Bearer ${ADMIN}`, 'x-forwarded-for': '1.2.3.4' })).status, 404)
  assert.equal((await post('/api/admin/pause', { paused: true })).status, 401)
  assert.equal((await post('/api/admin/pause', { paused: true }, { authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await post('/api/admin/pause', { paused: true, why: 'test' }, { authorization: `Bearer ${ADMIN}` })).status, 200)
  assert.equal((await post('/api/submit', { channel: 'email', from: 'billing@northwind-hosting.example', text: 'hi' })).status, 409)
  const pot = await (await fetch(url + '/api/pot')).json() as any
  assert.equal(pot.paused, 'test')
  await post('/api/admin/pause', { paused: false }, { authorization: `Bearer ${ADMIN}` })
})

test('spend is for the operator: the admin gate guards it and the public pot never shows it', async () => {
  store.addModelCall('claude-haiku-5-5', { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 }, 0.00015)
  const get = (headers: Record<string, string> = {}) => fetch(url + '/api/admin/spend', { headers })
  assert.equal((await get()).status, 401)
  assert.equal((await get({ authorization: `Bearer ${ADMIN}`, 'x-forwarded-for': '1.2.3.4' })).status, 404)
  const r = await get({ authorization: `Bearer ${ADMIN}` })
  assert.equal(r.status, 200)
  const s = await r.json() as any
  assert.equal(s.today.calls, 1)
  assert.equal(s.allTime.usd, 0.00015)
  assert.deepEqual(s.prices, { inPerMtok: 0.1, outPerMtok: 0.5 })
  assert.equal(s.budgetUsd, null)
  assert.equal(s.budgetPer, 'UTC day')
  const pot = JSON.stringify(await (await fetch(url + '/api/pot')).json())
  assert.doesNotMatch(pot, /usd|spend|tokens/i)
  assert.equal((await fetch(url + '/api/admin/other', { headers: { authorization: `Bearer ${ADMIN}` } })).status, 404)
})

test('the pot passes only the named fields of its nested objects', async () => {
  const pot = await (await fetch(url + '/api/pot')).json() as any
  assert.deepEqual(Object.keys(pot.stats), ['attempts', 'blocked', 'paid', 'wins', 'pending', 'vendorPaid'])
  assert.deepEqual(Object.keys(pot.vendors[0]), ['name', 'address'])
  assert.deepEqual(Object.keys(pot.limits), ['textChars', 'feedPage'])
})

test('a budget pause shows on the pot as paused for budget', async () => {
  agent.pause(BUDGET_PAUSE)
  const pot = await (await fetch(url + '/api/pot')).json() as any
  assert.equal(pot.budgetPaused, true)
  assert.ok(pot.paused)
  agent.resume()
  assert.equal(((await (await fetch(url + '/api/pot')).json()) as any).budgetPaused, false)
})

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

// what the strict policy would block, so a page that has any of it would break: inline scripts and styles, handlers,
// and anything loaded from another origin
function assertSelfContained(html: string, page: string) {
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) assert.match(m[1], /\bsrc="\/game\//, `${page}: a script without a /game/ src`)
  assert.doesNotMatch(html, /<style\b|\sstyle="|\son[a-z]+=/i, `${page}: inline style or handler`)
  for (const m of html.matchAll(/<(?:link|script|img|source|iframe)\b[^>]*\b(?:href|src)="([^"]+)"/gi)) assert.match(m[1], /^\/game\//, `${page}: loads ${m[1]}`)
}

test('the game page carries the terms footer, links the rules and privacy, and never says prize or bounty', async () => {
  const r = await fetch(url + '/game/')
  assert.equal(r.headers.get('content-security-policy'), CSP)
  const html = await r.text()
  assertSelfContained(html, '/game/')
  const foot = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'))
  for (const s of ['Base Sepolia', 'test ETH that has no value', '18 or older', 'sanctions list', 'public on the feed', 'mailto:security@saysoio.com',
    'sayso team', 'Not affiliated with Devcon or the Ethereum Foundation', 'href="/game/rules.html"', 'href="https://saysoio.com/privacy"']) assert.ok(foot.includes(s), s)
  assert.ok(html.includes('The transfer is yours (test ETH, no value).'))
  assert.doesNotMatch(html, /prize|bount/i)
  assert.doesNotMatch(html, /id="handle"|your handle/i)
  // every script is named by content hash, the posing check before the page script that uses it
  assert.match(html, /<script src="\/game\/posing\.js\?v=[0-9a-f]{10}" defer><\/script>\s*<script src="\/game\/app\.js\?v=[0-9a-f]{10}" defer>/)
  assert.match(html, /\/game\/style\.css\?v=[0-9a-f]{10}"/)
  const js = await fetch(url + '/game/posing.js')
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type')!, /^text\/javascript/)
})

test('the rules page is served under the same policy, with the win, conduct and privacy sections', async () => {
  const r = await fetch(url + '/game/rules.html')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-security-policy'), CSP)
  assert.match(r.headers.get('content-type')!, /^text\/html/)
  const html = await r.text()
  assertSelfContained(html, '/game/rules.html')
  assert.match(html, /\/game\/style\.css\?v=[0-9a-f]{10}"/, 'the stylesheet is named by content hash')
  for (const s of ['How a round works', 'The transfer is yours (test ETH, no value).', 'The game pauses after a win', 'There are no prizes', 'not a prize',
    '18 or older', 'sanctions', 'Do not impersonate real people or real companies', 'We may remove any entry and block any player', 'can change or stop at any time',
    'Privacy notice', 'IPv4 address in full', 'no end date', 'Anthropic', 'Amsterdam', 'mailto:security@saysoio.com', 'https://saysoio.com/privacy']) assert.ok(html.includes(s), s)
  assert.doesNotMatch(html, /secures|guarantee|100%|audited/i)
  // no handle is asked for, shown, sent on or remembered
  assert.doesNotMatch(html, /your handle|under a handle you choose|tries per handle/i)
  assert.ok(html.includes('The game no longer asks for a handle and keeps none.'))
  assert.equal(r.headers.get('cache-control'), 'no-cache')
})

test('the page is served with a strict policy, and nothing outside public/game is', async () => {
  const page = await fetch(url + '/game/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/)
  for (const p of ['/game/../src/config.ts', '/game/%2e%2e/package.json', '/game/../../.env', '/package.json', '/src/main.ts']) {
    assert.equal((await fetch(url + p)).status, 404, p)
  }
})
