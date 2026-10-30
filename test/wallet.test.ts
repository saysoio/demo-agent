// SaysoPayer against saysoio 0.7.0 with a pretend sayso (verdicts signed by a test key) and a pretend Base node: only a
// verified allow is signed; a block, an ask, a forged allow, an outage or a timeout is not; the pause still stops a
// signature after the allow; fees stay bounded by DEMO_MAX_FEE_GWEI.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { custom, getAddress, parseGwei, parseTransaction, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { DEFAULT_FEE_BOUNDS, modeQueryDigest, OATHLINE_TYPES, oathlineDomain, txDigest } from 'saysoio'
import { loadConfig } from '../src/config.ts'
import { feeBounds, gatedSigner, SaysoPayer } from '../src/wallet.ts'

const VENDOR: Address = getAddress('0x1111111111111111111111111111111111111111')
const CTX = { reason: 'pay the invoice', inputs: ['invoice'] }
const saysoKey = privateKeyToAccount(generatePrivateKey())
const forger = privateKeyToAccount(generatePrivateKey())
const now = () => Math.floor(Date.now() / 1000)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const cfg = (env: Record<string, string> = {}) => loadConfig({ DEMO_FAKE: '1', DEMO_NETWORK: 'base', DEMO_ASSET: 'eth', DEMO_MAX_PER_PAYMENT: '0.001', DEMO_SAYSO_API: 'http://127.0.0.1:1', DEMO_SAYSO_API_KEY: 'ol_test', ...env })

async function modeStatement(digest: Hex, wallet: Address) {
  const m = { wallet, txDigest: digest, mode: 'enforce' as const, setAt: 100, expiresAt: now() + 120 }
  const signature = await saysoKey.signTypedData({ domain: oathlineDomain(8453), types: OATHLINE_TYPES, primaryType: 'ModeStatement', message: { ...m, setAt: 100n, expiresAt: BigInt(m.expiresAt) } })
  return { ...m, signer: saysoKey.address, signature }
}
async function receipt(verdict: string, digest: Hex, wallet: Address, by = saysoKey) {
  const r = { wallet, txDigest: digest, mandateId: `0x${'ab'.repeat(32)}` as Hex, verdict, issuedAt: now(), expiresAt: now() + 120 }
  const signature = await by.signTypedData({ domain: oathlineDomain(8453), types: OATHLINE_TYPES, primaryType: 'Verdict', message: { ...r, issuedAt: BigInt(r.issuedAt), expiresAt: BigInt(r.expiresAt) } })
  return { ...r, signer: by.address, signature }
}

type Answer = 'allow' | 'block' | 'ask' | 'ask-owner' | 'forged-allow' | 'refusal' | 'outage' | 'down' | 'hang'
/** a pretend sayso: every check gets `answer`; counts the checks */
function sayso(wallet: Address, answer: Answer, seen = { checks: 0, approvals: 0 }) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.endsWith('/unchecked')) return json(200, { ok: true })
    if (u.includes('/wallets/')) return json(200, { kind: 'plain' })
    if (u.includes('/approvals/')) { seen.approvals++; return json(200, { status: 'pending' }) }
    const b = JSON.parse(String(init?.body))
    if (u.endsWith('/mode')) return json(200, { wallet, mode: await modeStatement(modeQueryDigest(wallet, b.nonce, 8453), wallet) })
    seen.checks++
    if (answer === 'down') throw new TypeError('fetch failed')
    if (answer === 'outage') return json(503, { error: 'unavailable' })
    if (answer === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    if (answer === 'refusal') return json(403, { error: 'no mandate for this wallet', code: 'no-mandate' })
    const d = txDigest({ wallet, to: b.tx.to, data: b.tx.data, value: b.tx.value !== undefined ? BigInt(b.tx.value) : undefined, nonce: b.tx.nonce }, 8453)
    const verdict = answer === 'forged-allow' ? 'allow' : answer === 'ask-owner' ? 'ask' : answer
    const rules = answer === 'block' ? [{ id: 'recipient-unknown', verdict: 'block' }] : []
    return json(200, { verdict, reason: `pretend ${verdict}`, rules, receipt: await receipt(verdict, d, wallet, answer === 'forged-allow' ? forger : saysoKey), mode: await modeStatement(d, wallet),
      ...(answer === 'ask-owner' ? { approval: { id: 'ap_1', channel: 'telegram', expiresAt: now() + 600 } } : {}) })
  }
}

/** a pretend Base node with the given base fee; records what was broadcast */
function node(sent: Hex[], baseFee = parseGwei('0.005'), priority = parseGwei('0.001')) {
  return custom({
    async request({ method, params }: { method: string; params?: any }) {
      if (method === 'eth_sendRawTransaction') { sent.push(params[0]); return `0x${'aa'.repeat(32)}` }
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: `0x${baseFee.toString(16)}`, number: '0x1', timestamp: '0x1', hash: `0x${'0'.repeat(64)}` }
      if (method === 'eth_maxPriorityFeePerGas') return `0x${priority.toString(16)}`
      if (method === 'eth_chainId') return '0x2105'
      if (method === 'eth_getTransactionCount') return '0x7'
      if (method === 'eth_estimateGas') return '0x5208'
      if (method === 'eth_getCode') return '0x'
      return null
    },
  })
}

/** a payer on a fresh agent key (the SDK's hourly fee budget is per wallet), counting every signature the key makes */
function payer(answer: Answer, o: { baseFee?: bigint; env?: Record<string, string> } = {}) {
  const key = privateKeyToAccount(generatePrivateKey())
  const signs = { n: 0 }, seen = { checks: 0, approvals: 0 }, sent: Hex[] = []
  const counted = { ...key, signTransaction: (tx: any, opts?: any) => { signs.n++; return key.signTransaction(tx, opts) } }
  const p = new SaysoPayer(cfg(o.env), counted as any, { fetch: sayso(key.address, answer, seen) as typeof fetch, signer: saysoKey.address, transport: node(sent, o.baseFee) })
  return { p, signs, seen, sent }
}
const go = () => false

test('a verified allow is signed once, with our gas limit, and broadcast', async () => {
  const { p, signs, seen, sent } = payer('allow')
  const r = await p.pay(VENDOR, 1000n, CTX, go)
  assert.equal(r.outcome, 'paid', r.note ?? '')
  assert.equal(r.verdict, 'allow')
  assert.equal(seen.checks, 1)
  assert.equal(signs.n, 1)
  assert.equal(sent.length, 1)
  const tx = parseTransaction(sent[0])
  assert.equal(tx.to?.toLowerCase(), VENDOR.toLowerCase())
  assert.equal(tx.value, 1000n)
  assert.equal(tx.gas, 21_000n)
  assert.ok(tx.maxFeePerGas! <= parseGwei('1'))
})

for (const [answer, outcome] of [['block', 'blocked'], ['ask', 'asked'], ['refusal', 'blocked']] as const) {
  test(`sayso's ${answer} is not signed (${outcome})`, async () => {
    const { p, signs, sent } = payer(answer)
    const r = await p.pay(VENDOR, 1000n, CTX, go)
    assert.equal(r.outcome, outcome)
    assert.equal(r.txHash, null)
    assert.equal(signs.n, 0)
    assert.deepEqual(sent, [])
  })
}

test('a block names its rule in the feed', async () => {
  const r = await payer('block').p.pay(VENDOR, 1000n, CTX, go)
  assert.equal(r.verdict, 'block')
  assert.equal(r.rule, 'unknown payee')
})

for (const answer of ['forged-allow', 'outage', 'down'] as const) {
  test(`no verified allow (${answer}) is not signed and shows no verdict`, async () => {
    const { p, signs, sent, seen } = payer(answer)
    const r = await p.pay(VENDOR, 1000n, CTX, go)
    assert.equal(seen.checks, 1)
    assert.equal(r.outcome, 'unavailable')
    assert.deepEqual([r.verdict, r.reason, r.rule], [null, null, null])
    assert.equal(signs.n, 0)
    assert.deepEqual(sent, [])
  })
}

test('a check that runs past 10 s is refused, not signed', async () => {
  const { p, signs, sent, seen } = payer('hang')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let done: Awaited<ReturnType<typeof p.pay>> | null = null
    const run = p.pay(VENDOR, 1000n, CTX, go).then(r => { done = r; return r })
    for (let i = 0; i < 200 && seen.checks === 0; i++) await new Promise(r => setImmediate(r))
    assert.equal(seen.checks, 1)
    mock.timers.tick(9_999)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    assert.equal(done, null, 'still waiting just under the SDK default of 10 s')
    mock.timers.tick(1)
    const r = await run
    assert.equal(r.outcome, 'unavailable')
    assert.equal(r.verdict, null)
  } finally { mock.timers.reset() }
  assert.equal(signs.n, 0)
  assert.deepEqual(sent, [])
})

test('our pause check blocks the signature after sayso allowed', async () => {
  const { p, signs, sent, seen } = payer('allow')
  // not paused when the payment starts; paused once sayso has answered
  const r = await p.pay(VENDOR, 1000n, CTX, () => seen.checks > 0)
  assert.equal(seen.checks, 1)
  assert.equal(r.outcome, 'paused')
  assert.match(r.note!, /paused before signing/)
  assert.equal(signs.n, 0)
  assert.deepEqual(sent, [])
})

test('a paused game is neither checked nor signed', async () => {
  const { p, signs, seen } = payer('allow')
  const r = await p.pay(VENDOR, 1000n, CTX, () => true)
  assert.equal(r.outcome, 'paused')
  assert.equal(seen.checks, 0)
  assert.equal(signs.n, 0)
})

test('fees above DEMO_MAX_FEE_GWEI are not checked and not signed', async () => {
  const { p, signs, seen, sent } = payer('allow', { baseFee: parseGwei('2') })
  const r = await p.pay(VENDOR, 1000n, CTX, go)
  assert.equal(r.outcome, 'error')
  assert.match(r.note!, /fees are above the ceiling/)
  assert.equal(seen.checks, 0)
  assert.equal(signs.n, 0)
  assert.deepEqual(sent, [])
})

test('the SDK\'s hourly fee bound refuses after the allow; the allow stays on record and nothing more is sent', async () => {
  // fees just under the 1 gwei ceiling: 60 payments' worth of the per-payment maximum fit in an hour, a few more do not
  const { p, sent } = payer('allow', { baseFee: parseGwei('0.8') })
  let r = await p.pay(VENDOR, 1n, CTX, go)
  let paid = 0
  while (r.outcome === 'paid' && paid < 100) { paid++; r = await p.pay(VENDOR, 1n, CTX, go) }
  assert.ok(paid >= 60 && paid < 70, `paid ${paid}`)
  assert.equal(r.outcome, 'error')
  assert.equal(r.verdict, 'allow')
  assert.match(r.note!, /SDK refused the signed transaction/)
  assert.equal(sent.length, paid)
})

test('feeBounds tighten the SDK defaults to DEMO_MAX_FEE_GWEI and our gas limit', () => {
  assert.deepEqual(feeBounds('1', null), { maxFeeMultiple: 4, maxPriorityFeePerGas: parseGwei('1'), maxFeeWei: 21_000n * parseGwei('1'), hourlyFeeWei: 60n * 21_000n * parseGwei('1') })
  const usdc = feeBounds('1', getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'))
  assert.equal(usdc.maxFeeWei, 100_000n * parseGwei('1'))
  // a loose ceiling never loosens the SDK's own defaults
  assert.deepEqual(feeBounds('1000', getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')), { ...DEFAULT_FEE_BOUNDS })
  assert.throws(() => feeBounds('0', null), /DEMO_MAX_FEE_GWEI must be above 0/)
})

test('an ask put to the owner is not waited for and not signed', async () => {
  const { p, signs, sent, seen } = payer('ask-owner')
  const t0 = Date.now()
  const r = await p.pay(VENDOR, 1000n, CTX, go)
  assert.ok(Date.now() - t0 < 2_000)
  assert.equal(r.outcome, 'asked')
  assert.equal(r.verdict, 'ask')
  assert.match(r.note!, /does not wait for approval/)
  assert.equal(seen.approvals, 0)
  assert.equal(signs.n, 0)
  assert.deepEqual(sent, [])
  // the queue is free: the next payment is checked at once
  assert.equal((await p.pay(VENDOR, 1000n, CTX, go)).outcome, 'asked')
  assert.equal(seen.checks, 2)
})

test('our signer refuses without a verified allow, when paused, and for messages', async () => {
  const key = privateKeyToAccount(generatePrivateKey())
  let n = 0
  const inner = { ...key, signTransaction: (tx: any, o?: any) => { n++; return key.signTransaction(tx, o) } }
  const tx = { to: VENDOR, value: 1n, chainId: 8453, nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' as const }
  const state = { paused: false, allowed: false }
  const s = gatedSigner(inner as any, () => state.paused, () => state.allowed)
  await assert.rejects(s.signTransaction!(tx), { name: 'NoVerifiedAllow' })
  state.paused = true; state.allowed = true
  await assert.rejects(s.signTransaction!(tx), { name: 'GamePaused' })
  assert.equal(n, 0)
  state.paused = false
  assert.equal(parseTransaction(await s.signTransaction!(tx)).to?.toLowerCase(), VENDOR.toLowerCase())
  assert.equal(n, 1)
  await assert.rejects(s.signMessage!({ message: 'hi' }), /signs no messages/)
  await assert.rejects(s.signTypedData!({ domain: {}, types: { M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', message: { a: 1n } } as any), /signs no typed data/)
})
