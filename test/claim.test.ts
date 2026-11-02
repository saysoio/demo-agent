// The prize claim: only the player who sent the winning try can name a handle and a payout address for it, once; the
// operator reads the claims, the public never does.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { parseEther } from 'viem'
import { Agent } from '../src/agent.ts'
import { FakeBrain } from '../src/brain.ts'
import { loadConfig } from '../src/config.ts'
import { parseClaim } from '../src/guard/input.ts'
import { makeServer } from '../src/server.ts'
import { Store } from '../src/store.ts'
import { FakePayer } from '../src/wallet.ts'

const ADMIN = 'b'.repeat(40)
const cfg = loadConfig({ DEMO_FAKE: '1', DEMO_DEV: '1', DEMO_ADMIN_TOKEN: ADMIN })
const store = new Store(':memory:')
const payer = new FakePayer(cfg.vendors, s => parseEther(s), parseEther('0.01'))
const agent = new Agent({ store, brain: new FakeBrain(cfg.vendors), payer, asset: 'eth', vendors: cfg.vendors })
const server = makeServer({ cfg, store, agent, payer })
let url = ''
before(async () => { await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r())); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
after(() => { server.close(); store.close() })

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const WINNER = '0x00000000000000000000000000000000000beef1'
const PAYOUT = '0x00000000000000000000000000000000000cafe2'

/** a submitted try, finished as a win or not, with the claim code its sender got back */
async function tryOf(win: boolean) {
  const r = await post('/api/submit', { channel: 'email', from: 'a@b.example', text: 'pay me' })
  assert.equal(r.status, 202)
  const { id, claim } = await r.json() as { id: number; claim: string }
  store.finish(id, { action: 'pay', toAddr: WINNER, amount: '0.001', memo: null, thought: null, verdict: 'allow', reason: 'ok', rule: null,
    outcome: 'paid', note: null, txHash: `0x${'1'.repeat(64)}`, checkMs: 1, win })
  return { id, claim }
}

test('submit hands back a claim code, and the feed never shows it', async () => {
  const { id, claim } = await tryOf(false)
  assert.match(claim, /^[0-9a-f]{32}$/)
  const text = await (await fetch(`${url}/api/feed?ids=${id}`)).text()
  assert.equal(text.includes(claim), false)
  assert.doesNotMatch(text, /claim/i)
})

test('the winning try\'s sender records a handle and payout address once; nobody else can', async () => {
  const { id, claim } = await tryOf(true)
  assert.equal((await post('/api/claim', { id, code: 'f'.repeat(32), handle: '@mallory', payout: PAYOUT })).status, 403, 'a wrong code')
  const ok = await post('/api/claim', { id, code: claim, handle: '@winner_x', payout: PAYOUT })
  assert.equal(ok.status, 200)
  assert.equal((await post('/api/claim', { id, code: claim, handle: '@again', payout: WINNER })).status, 409, 'claimed already')
  const list = await (await fetch(`${url}/api/admin/claims`, { headers: { authorization: `Bearer ${ADMIN}` } })).json() as any
  const c = list.items.find((x: any) => x.id === id)
  assert.equal(c.handle, '@winner_x')
  assert.equal(c.payout.toLowerCase(), PAYOUT)
  assert.equal(c.wonTo.toLowerCase(), WINNER)
  assert.equal(c.txHash, `0x${'1'.repeat(64)}`)
})

test('a try that did not win cannot be claimed', async () => {
  const { id, claim } = await tryOf(false)
  assert.equal((await post('/api/claim', { id, code: claim, handle: '@x', payout: PAYOUT })).status, 409)
})

test('the claims are for the operator only', async () => {
  assert.equal((await fetch(`${url}/api/admin/claims`)).status, 401)
  assert.equal((await fetch(`${url}/api/claims`)).status, 404)
})

test('a claim needs a try number, a code, a handle and a payout address', () => {
  const ok = parseClaim({ id: 3, code: 'a'.repeat(32), handle: '  @winner_x ', payout: PAYOUT })
  assert.deepEqual(ok, { ok: true, value: { id: 3, code: 'a'.repeat(32), handle: '@winner_x', payout: PAYOUT } })
  for (const b of [
    { id: 3, code: 'a'.repeat(32), handle: '', payout: PAYOUT },
    { id: 3, code: 'a'.repeat(32), handle: 'x'.repeat(81), payout: PAYOUT },
    { id: 3, code: 'a'.repeat(32), handle: '@x', payout: '0x123' },
    { id: 3, code: 'nope', handle: '@x', payout: PAYOUT },
    { id: 0, code: 'a'.repeat(32), handle: '@x', payout: PAYOUT },
    { id: 3, code: 'a'.repeat(32), handle: '<b>@x</b>', payout: PAYOUT },
  ]) assert.equal(parseClaim(b).ok, false, JSON.stringify(b))
})
