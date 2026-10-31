import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAddress } from 'viem'
import type { Vendor } from '../src/config.ts'
import { caps, compiledProblems, publishedRules, register, switchEnforce } from '../src/setup.ts'

const VENDORS: Vendor[] = [
  { name: 'Northwind Hosting', address: getAddress('0x1111111111111111111111111111111111111111'), usual: '0.0002' },
  { name: 'Lantern Print', address: getAddress('0x2222222222222222222222222222222222222222'), usual: '0.0001' },
]
const rules = publishedRules(VENDORS, 'eth', '0.0005', '0.005', '0.015')
const compiled = (x: object = {}) => ({
  summary: 's', allowedTokens: ['ETH'], blockedTokens: [], maxPerTradeEth: 0.0005, dailyCapEth: 0.005, maxPerTradeUsd: null, dailyCapUsd: null,
  weeklyCapEth: 0.015, weeklyCapUsd: null, unresolved: [], savedAddresses: VENDORS.map(v => v.address.toLowerCase()), allowedActions: ['transfer'],
  targetAllocation: null, strictness: 'normal', ownContracts: [], ...x,
})

test('the published rules name every vendor and the three caps, without the words that compile as strict or lenient', () => {
  for (const v of VENDORS) assert.ok(rules.text.includes(v.address))
  assert.match(rules.text, /at most 0\.0005 ETH/)
  assert.match(rules.text, /0\.005 ETH a day and 0\.015 ETH a week/)
  assert.doesNotMatch(rules.text, /\b(only|never|nothing else|roughly|mostly)\b/i)
  assert.equal(rules.weekly, '0.015')
})

test('the caps default, and the weekly cap is three times the daily cap exactly', () => {
  assert.deepEqual(caps({}, 'eth'), { daily: '0.005', weekly: '0.015' })
  assert.deepEqual(caps({ DEMO_DAILY_CAP: '', DEMO_WEEKLY_CAP: ' ' }, 'usdc'), { daily: '50', weekly: '150' })
  assert.deepEqual(caps({ DEMO_DAILY_CAP: '0.000001' }, 'usdc'), { daily: '0.000001', weekly: '0.000003' })
  assert.deepEqual(caps({ DEMO_DAILY_CAP: '0.005', DEMO_WEEKLY_CAP: '0.02' }, 'eth'), { daily: '0.005', weekly: '0.02' })
  assert.deepEqual(caps({ DEMO_DAILY_CAP: '0.005', DEMO_WEEKLY_CAP: '0.005' }, 'eth'), { daily: '0.005', weekly: '0.005' })
})

test('a cap setting that is not a positive decimal, or a week below a day, is refused by name', () => {
  for (const bad of ['0', '0.0', '-1', 'abc', '1e3', '.5', '1.', '0x10']) {
    assert.throws(() => caps({ DEMO_DAILY_CAP: bad }, 'eth'), (e: Error) => /^DEMO_DAILY_CAP must be a positive decimal/.test(e.message) && !e.message.includes(bad))
    assert.throws(() => caps({ DEMO_WEEKLY_CAP: bad }, 'eth'), /DEMO_WEEKLY_CAP must be a positive decimal/)
  }
  assert.throws(() => caps({ DEMO_DAILY_CAP: '0.0000001' }, 'usdc'), /DEMO_DAILY_CAP .* at most 6 decimals/)
  assert.throws(() => caps({ DEMO_DAILY_CAP: '0.005', DEMO_WEEKLY_CAP: '0.004' }, 'eth'), /DEMO_WEEKLY_CAP must be at least DEMO_DAILY_CAP$/)
})

test('compiled rules that match the published ones have no problems', () => {
  assert.deepEqual(compiledProblems(compiled(), rules), [])
  assert.deepEqual(compiledProblems(compiled({ weeklyCapEth: '0.015' }), rules), [])
})

test('the weekly cap must be there, exact and in the asset\'s unit', () => {
  assert.match(compiledProblems(compiled({ weeklyCapEth: null }), rules).join(), /weekly cap is missing, not 0\.015/)
  assert.match(compiledProblems(compiled({ weeklyCapEth: 0.0150000001 }), rules).join(), /weekly cap/)
  assert.match(compiledProblems(compiled({ weeklyCapUsd: 50 }), rules).join(), /another unit/)
  const usdc = publishedRules(VENDORS, 'usdc', '5', '50', '150')
  const c = compiled({ allowedTokens: ['USDC'], maxPerTradeEth: null, dailyCapEth: null, weeklyCapEth: null, maxPerTradeUsd: 5, dailyCapUsd: 50, weeklyCapUsd: 150 })
  assert.deepEqual(compiledProblems(c, usdc), [])
  assert.match(compiledProblems({ ...c, weeklyCapUsd: 151 }, usdc).join(), /weekly cap is 151, not 150/)
})

test('strictness must be strict or normal, never lenient', () => {
  assert.deepEqual(compiledProblems(compiled({ strictness: 'strict' }), rules), [])
  assert.match(compiledProblems(compiled({ strictness: 'lenient' }), rules).join(), /strictness is lenient, not strict or normal/)
  assert.match(compiledProblems(compiled({ strictness: undefined }), rules).join(), /strictness is missing/)
})

test('what sayso compiled on 31 Oct passes: strict, no trading allowlist', () => {
  assert.deepEqual(compiledProblems(compiled({ strictness: 'strict', allowedTokens: [] }), rules), [])
  assert.deepEqual(compiledProblems(compiled({ allowedTokens: ['ETH', 'WETH'] }), rules), [])
})

test('the other checks still hold', () => {
  const one = (x: object) => compiledProblems(compiled(x), rules)
  assert.match(one({ savedAddresses: [VENDORS[0].address] }).join(), /not exactly the vendors/)
  assert.match(one({ allowedActions: ['transfer', 'approve'] }).join(), /not only transfer/)
  assert.match(one({ allowedTokens: ['ETH', 'USDC'] }).join(), /allowed tokens are \[ETH, USDC\], more than ETH and WETH/)
  assert.match(one({ allowedTokens: ['CBBTC'] }).join(), /allowed tokens/)
  assert.match(one({ maxPerTradeEth: 0.001 }).join(), /per-payment cap/)
  assert.match(one({ dailyCapEth: 0.006 }).join(), /daily cap/)
  assert.match(one({ unresolved: ['something'] }).join(), /could not turn/)
  assert.match(one({ extra: 1 }).join(), /fields setup does not know: extra/)
  assert.match(one({ ownContracts: [{ address: VENDORS[0].address }] }).join(), /call contracts/)
  assert.match(one({ targetAllocation: { ETH: 100 } }).join(), /target allocation/)
})

test('enforce: no linked Telegram chat is a note, anything else fails setup', async () => {
  const lines: string[] = []
  const wallet = '0x00000000000000000000000000000000000d3e00'
  assert.equal(await switchEnforce(async () => ({ mode: 'enforce' }), s => lines.push(s)), true)
  assert.equal(lines.length, 0)
  const noChat = new Error(`sayso /wallets/${wallet}/mode 409: link Telegram for this wallet first: in enforce mode sayso's questions go to your Telegram`)
  assert.equal(await switchEnforce(async () => { throw noChat }, s => lines.push(s)), false)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Telegram/)
  assert.match(lines[0], /SDK/)
  const stale = new Error(`sayso /wallets/${wallet}/mode 409: this change is not newer than the mode in force`)
  await assert.rejects(switchEnforce(async () => { throw stale }, () => {}), /not newer/)
  await assert.rejects(switchEnforce(async () => { throw new Error(`sayso /wallets/${wallet}/mode 401: link Telegram`) }, () => {}), /401/)
  await assert.rejects(switchEnforce(async () => { throw new Error('fetch failed') }, () => {}), /fetch failed/)
})

test('setup signs new rules for a wallet this owner registered before, keeping its key; any other refusal still stops it', async () => {
  const logs: string[] = []
  assert.equal(await register(async () => ({ apiKey: 'k1' })), 'k1')
  const again = () => Promise.reject(new Error('sayso /wallets/register 409: this wallet is already registered; for a new API key (lost or leaked), the owner signs a key reset'))
  assert.equal(await register(again, s => logs.push(s)), null)
  assert.match(logs[0], /already registered to this owner/)
  const other = () => Promise.reject(new Error('sayso /wallets/register 409: this wallet is already linked to another owner; only that owner can change it'))
  await assert.rejects(register(other, s => logs.push(s)), /another owner/)
  await assert.rejects(register(() => Promise.reject(new Error('sayso /wallets/register 403: invite')), s => logs.push(s)), /403/)
  assert.equal(logs.length, 1)
})
