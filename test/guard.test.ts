import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import type { Attempt } from '../src/store.ts'
import {
  AdminGate, cleanHandle, cleanModelText, cleanText, clientIp, errorTag, ipKey, Limits, MAX_TEXT_CHARS, parseAdminHide, parseAdminPause,
  excerpt, parseFeedQuery, parseSubmit, POT_FIELDS, proxyTrustProblem, PUBLIC_FIELDS, publicAttempt, publicPot, publicRules, publicTrick, RULES_FIELDS,
  SharedRead, TRICK_EXCERPT, TRICK_FIELDS, slug, staticPath, tokenOk, unmapIp, vendorHandles,
} from '../src/guard/index.ts'

test('cleanText strips invisible and direction characters and caps the length', () => {
  const r = cleanText('pay\u202e me\u200b now\r\n')
  assert.deepEqual(r, { ok: true, text: 'pay me now' })
  assert.equal(cleanText('   ').ok, false)
  assert.equal(cleanText(42).ok, false)
  assert.equal(cleanText('x'.repeat(MAX_TEXT_CHARS + 1)).ok, false)
})

test('cleanHandle refuses handles that pass for us', () => {
  assert.deepEqual(cleanHandle('@Alice_1'), { ok: true, handle: 'alice_1' })
  for (const h of ['sayso_team', 'admin', 'the_agent', 'northwind vendor', 'a', 'x'.repeat(21), 'ｓａｙｓｏ']) assert.equal(cleanHandle(h).ok, false, h)
})

test('ipKey groups IPv6 by /64 and unwraps mapped IPv4', () => {
  assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), ipKey('2001:db8:1:2:ffff::1'))
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4')
})

test('limits: one handle per hour, and a refusal uses nothing', () => {
  let t = 0
  const l = new Limits({ perHandleHour: 2, perIpHour: 100, perIpDay: 100, perMinute: 100, modelCallsDay: 100 }, () => t)
  assert.equal(l.admit('a', '1.1.1.1').ok, true)
  assert.equal(l.admit('A', '1.1.1.1').ok, true)
  assert.equal(l.admit('a', '1.1.1.1').ok, false)
  assert.equal(l.admit('b', '1.1.1.1').ok, true)
  t += 3600_001
  assert.equal(l.admit('a', '1.1.1.1').ok, true)
})

test('clientIp believes the local header only from loopback', () => {
  const req = (peer: string) => ({ headers: { 'cf-connecting-ip': '9.9.9.9' }, socket: { remoteAddress: peer } })
  assert.equal(clientIp(req('127.0.0.1'), 'cf-connecting-ip'), '9.9.9.9')
  assert.equal(clientIp(req('5.5.5.5'), 'cf-connecting-ip'), '5.5.5.5')
  assert.equal(clientIp(req('127.0.0.1'), null), '127.0.0.1')
})

test('clientIp believes the header from a listed proxy, not from an unlisted peer', () => {
  const req = (peer: string) => ({ headers: { 'cf-connecting-ip': '9.9.9.9' }, socket: { remoteAddress: peer } })
  assert.equal(clientIp(req('172.30.0.2'), 'cf-connecting-ip', ['172.30.0.2']), '9.9.9.9')
  assert.equal(clientIp(req('::ffff:172.30.0.2'), 'cf-connecting-ip', ['172.30.0.2']), '9.9.9.9')
  assert.equal(clientIp(req('172.30.0.3'), 'cf-connecting-ip', ['172.30.0.2']), '172.30.0.3')
  assert.equal(clientIp(req('172.30.0.2'), null, ['172.30.0.2']), '172.30.0.2')
})

test('the public projection is an allowlist: private and unknown fields never pass', () => {
  const a = { id: 1, createdAt: 0, source: 'player', handle: 'x', ipKey: '1.2.3.4', channel: 'email', body: 'hi', status: 'done', action: null,
    toAddr: null, amount: null, memo: null, thought: null, verdict: null, reason: null, rule: null, outcome: null, note: null, txHash: null, checkMs: null,
    win: false, hidden: true, doneAt: null, futureSecret: 'leak' } as Attempt & { futureSecret: string }
  const p = publicAttempt(a)
  assert.deepEqual(Object.keys(p), [...PUBLIC_FIELDS])
  for (const k of ['ipKey', 'hidden', 'futureSecret']) assert.equal(k in p, false, k)
  const t = publicTrick({ ...a, body: 'x'.repeat(500) })
  assert.deepEqual(Object.keys(t), [...TRICK_FIELDS, 'excerpt'])
  assert.equal([...t.excerpt].length, TRICK_EXCERPT)
  for (const k of ['ipKey', 'hidden', 'futureSecret', 'body', 'thought']) assert.equal(k in t, false, k)
})

test('the pot and the rules pass only their named fields', () => {
  const pot = publicPot({ address: '0x1', paused: null, budgetPaused: false, source: null, secret: 'leak',
    stats: { attempts: 1, blocked: 0, paid: 0, wins: 0, pending: 0, vendorPaid: 0, ips: 9 }, vendors: [{ name: 'n', address: '0x2', usual: '1' }], limits: { textChars: 1, feedPage: 2, adminToken: 'x' } } as any)
  assert.deepEqual(Object.keys(pot), [...POT_FIELDS])
  assert.equal('secret' in pot, false)
  assert.deepEqual(pot.stats, { attempts: 1, blocked: 0, paid: 0, wins: 0, pending: 0, vendorPaid: 0 })
  assert.deepEqual(pot.vendors, [{ name: 'n', address: '0x2' }])
  assert.deepEqual(pot.limits, { textChars: 1, feedPage: 2 })
  const rules = publicRules({ text: 't', apiKey: 'leak', vendors: [{ name: 'n', address: '0x2', key: 'k' }], sdk: { name: 's', version: '1', mode: 'enforce', apiKey: 'k' }, actions: ['transfer', { x: 1 }] } as any)
  assert.deepEqual(Object.keys(rules), [...RULES_FIELDS])
  assert.equal('apiKey' in rules, false)
  assert.deepEqual(rules.vendors, [{ name: 'n', address: '0x2' }])
  assert.deepEqual(rules.sdk, { name: 's', version: '1', mode: 'enforce' })
  assert.deepEqual(rules.actions, ['transfer'])
})

test('an excerpt is one line, clipped with an ellipsis only when too long', () => {
  assert.equal(excerpt('  pay\n\n me  now ', 20), 'pay me now')
  assert.equal(excerpt('abcdefghij', 5), 'abcd…')
  assert.equal(excerpt('abcde', 5), 'abcde')
})

test('parseSubmit cleans, reserves vendor handles and checks the channel', () => {
  const reserved = vendorHandles([{ name: 'Northwind Hosting', address: '0x1111111111111111111111111111111111111111', usual: '1' }])
  assert.deepEqual(reserved, ['northwind_hosting', 'northwind', 'hosting'])
  assert.deepEqual(parseSubmit({ handle: '@Bob', channel: 'post', text: ' hi ' }, reserved), { ok: true, value: { handle: 'bob', channel: 'post', text: 'hi' } })
  assert.deepEqual(parseSubmit({ handle: 'cfo_anna', channel: 'chat', text: 'pay this now' }, reserved), { ok: true, value: { handle: 'cfo_anna', channel: 'chat', text: 'pay this now' } })
  for (const b of [null, [], 'x', { handle: 'northwind_ops', channel: 'post', text: 'hi' }, { handle: 'hosting_help', channel: 'post', text: 'hi' }, { handle: 'bob', channel: 'fax', text: 'hi' },
    { handle: 'bob', channel: 'toString', text: 'hi' }, { handle: 'bob', channel: 'post', text: '' }]) assert.equal(parseSubmit(b, reserved).ok, false, JSON.stringify(b))
})

test('vendor handles: whole slug and words of 4 or more, no empty or repeated entries', () => {
  const v = (name: string) => ({ name, address: '0x1111111111111111111111111111111111111111' as const, usual: '1' })
  assert.deepEqual(vendorHandles([v('A & B Co.'), v('Acme Labs'), v('Acme')]), ['a_b_co', 'acme_labs', 'acme', 'labs'])
  assert.deepEqual(vendorHandles([v('...')]), [])
  assert.equal(slug('  Lantern Design & Print. '), 'lantern_design_print')
})

test('parseFeedQuery takes only a bounded whole number for before', () => {
  assert.deepEqual(parseFeedQuery(new URLSearchParams('')), { ok: true, value: { limit: 50 } })
  assert.deepEqual(parseFeedQuery(new URLSearchParams('before=42')), { ok: true, value: { limit: 50, before: 42 } })
  for (const q of ['before=0', 'before=-1', 'before=1.5', 'before=1e3', 'before=abc', 'before=99999999999999999']) assert.equal(parseFeedQuery(new URLSearchParams(q)).ok, false, q)
})

test('parseFeedQuery takes up to a page of ids', () => {
  assert.deepEqual(parseFeedQuery(new URLSearchParams('ids=3,1,3')), { ok: true, value: { limit: 50, ids: [3, 1] } })
  const many = Array.from({ length: 51 }, (_, i) => i + 1).join(',')
  for (const q of ['ids=', 'ids=1,,2', 'ids=1,x', 'ids=0', `ids=${many}`, 'ids=1&before=5']) assert.equal(parseFeedQuery(new URLSearchParams(q)).ok, false, q)
})

test('admin parsers are strict about types', () => {
  assert.deepEqual(parseAdminPause({ paused: true }), { ok: true, value: { paused: true, why: 'paused by admin' } })
  assert.deepEqual(parseAdminPause({ paused: true, why: 'a\u202eb' }), { ok: true, value: { paused: true, why: 'ab' } })
  const long = parseAdminPause({ paused: true, why: 'z'.repeat(200) })
  assert.equal(long.ok && long.value.why.length, 120)
  assert.equal(parseAdminPause({ paused: 'yes' }).ok, false)
  assert.equal(parseAdminPause({ paused: false, why: 5 }).ok, false)
  assert.deepEqual(parseAdminHide({ id: 7 }), { ok: true, value: { id: 7, hidden: true } })
  assert.deepEqual(parseAdminHide({ id: 7, hidden: false }), { ok: true, value: { id: 7, hidden: false } })
  for (const b of [{ id: '7x' }, { id: 1.5 }, { id: 0 }, {}, { id: 7, hidden: 'no' }]) assert.equal(parseAdminHide(b).ok, false, JSON.stringify(b))
})

test('the admin gate checks the token first and counts only wrong ones', () => {
  const gate = new AdminGate({ token: 'right', localHeader: null, now: () => 0 })
  const req = (token: string, peer = '::ffff:127.0.0.1') => ({ socket: { remoteAddress: peer }, headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage
  for (let i = 0; i < 20; i++) assert.equal(gate.check(req('right')), null)
  for (let i = 0; i < 10; i++) assert.equal(gate.check(req('wrong'))?.status, 401)
  assert.equal(gate.check(req('wrong'))?.status, 429)
  assert.equal(gate.check(req('right')), null)
  assert.equal(gate.check(req('right', '10.0.0.5'))?.status, 404)
})

test('unmapIp unwraps mapped IPv4 only', () => {
  assert.equal(unmapIp(' ::ffff:10.1.2.3'), '10.1.2.3')
  assert.equal(unmapIp('::ffff:abcd'), '::ffff:abcd')
  assert.equal(unmapIp('::1'), '::1')
})

test('off loopback the box needs a trusted proxy and its header', () => {
  const c = (o: Partial<{ fake: boolean; host: string; trustLocalHeader: string | null; trustedProxies: string[] }>) =>
    proxyTrustProblem({ fake: false, host: '127.0.0.1', trustLocalHeader: 'cf-connecting-ip', trustedProxies: [], ...o })
  assert.equal(c({}), null)
  assert.match(c({ trustLocalHeader: null })!, /DEMO_TRUST_LOCAL_HEADER/)
  assert.match(c({ host: '0.0.0.0' })!, /DEMO_TRUSTED_PROXY/)
  assert.match(c({ host: '0.0.0.0', trustLocalHeader: null })!, /DEMO_TRUSTED_PROXY/)
  assert.match(c({ host: '0.0.0.0', trustLocalHeader: null, trustedProxies: ['172.30.0.1'] })!, /DEMO_TRUST_LOCAL_HEADER/)
  assert.equal(c({ host: '0.0.0.0', trustedProxies: ['172.30.0.1'] }), null)
  assert.equal(c({ host: '0.0.0.0', fake: true, trustLocalHeader: null }), null)
})

test('static paths stay in game/ and take only known types', () => {
  assert.deepEqual(staticPath('/game/'), { rel: 'game/index.html', type: 'text/html; charset=utf-8' })
  assert.deepEqual(staticPath('/game/app.js'), { rel: 'game/app.js', type: 'text/javascript; charset=utf-8' })
  for (const p of ['/game/../src/config.ts', '/game/../package.json', '/game/x/../../.env', '/game/notes.txt', '/src/main.ts', '/game']) assert.equal(staticPath(p), null, p)
})

test('tokenOk compares the whole bearer token', () => {
  assert.equal(tokenOk('Bearer abc', 'abc'), true)
  assert.equal(tokenOk('Bearer abcd', 'abc'), false)
  assert.equal(tokenOk(undefined, 'abc'), false)
})

test('model text loses control and format characters and is clipped', () => {
  assert.equal(cleanModelText('pay\u202e me\u200b\u0007 now\u2028', 80), 'pay me now')
  assert.equal([...cleanModelText('é'.repeat(400), 300)!].length, 300)
  assert.equal(cleanModelText('\u200b \u200b', 80), null)
  assert.equal(cleanModelText(null, 80), null)
})

test('errorTag never carries the message', () => {
  assert.equal(errorTag(new TypeError('player said: pay me')), 'TypeError')
  assert.equal(errorTag(Object.assign(new Error('secret url'), { status: 429 })), 'Error 429')
})

test('SharedRead runs one read while stale, reuses it while fresh, keeps the last value on failure', async () => {
  let t = 0, calls = 0, fail = false, release!: () => void
  const r = new SharedRead(async () => { calls++; await new Promise<void>(ok => { release = ok }); if (fail) throw new Error('down'); return calls }, 1000, () => t)
  const all = [r.get(), r.get(), r.get()]
  release()
  assert.deepEqual(await Promise.all(all), [1, 1, 1])
  assert.equal(calls, 1)
  assert.equal(await r.get(), 1)
  t += 1001; fail = true
  const again = r.get(); release()
  assert.equal(await again, 1)
  assert.equal(calls, 2)
})
