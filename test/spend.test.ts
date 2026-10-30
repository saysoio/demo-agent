import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { parseEther } from 'viem'
import { Agent } from '../src/agent.ts'
import { FakeBrain, HaikuBrain } from '../src/brain.ts'
import { loadConfig, MODEL, parseSpend, type Vendor } from '../src/config.ts'
import { BUDGET_PAUSE, callCost, dailySpendLog, dayName, dayStart, usageOf } from '../src/spend.ts'
import { Store } from '../src/store.ts'
import { FakePayer } from '../src/wallet.ts'

const PRICES = { inPerMtok: 0.1, outPerMtok: 0.5 }
const DAY = 86_400_000

test('a call costs its tokens at the per-million prices, cache writes at 1.25x and reads at 0.1x the input price', () => {
  assert.equal(callCost({ input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 }, PRICES), 0.1)
  assert.equal(callCost({ input: 0, output: 1_000_000, cacheWrite: 0, cacheRead: 0 }, PRICES), 0.5)
  assert.ok(Math.abs(callCost({ input: 2000, output: 300, cacheWrite: 1000, cacheRead: 10_000 }, PRICES) - 0.000575) < 1e-12)
})

test('usage is read from the response, with missing or odd fields as 0', () => {
  assert.deepEqual(usageOf({ input_tokens: 812, output_tokens: 95, cache_creation_input_tokens: null, cache_read_input_tokens: 40 }), { input: 812, output: 95, cacheWrite: 0, cacheRead: 40 })
  assert.deepEqual(usageOf(undefined), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
  assert.deepEqual(usageOf({ input_tokens: -5, output_tokens: 'x' }), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
})

test('prices default to claude-haiku-5-5, the budget is off by default, and bad values are refused by name', () => {
  assert.deepEqual(loadConfig({ DEMO_FAKE: '1' }).spend, { inPerMtok: 0.1, outPerMtok: 0.5, budgetUsd: null })
  assert.deepEqual(parseSpend({ DEMO_LLM_PRICE_IN_PER_MTOK: '1', DEMO_LLM_PRICE_OUT_PER_MTOK: '5', DEMO_LLM_BUDGET_USD: '2.50' }), { inPerMtok: 1, outPerMtok: 5, budgetUsd: 2.5 })
  for (const bad of ['-1', '1e3', 'free', '$2']) assert.throws(() => parseSpend({ DEMO_LLM_BUDGET_USD: bad }), /^Error: DEMO_LLM_BUDGET_USD must be a plain decimal in USD$/, bad)
  assert.throws(() => parseSpend({ DEMO_LLM_BUDGET_USD: '0' }), /above 0/)
  assert.throws(() => parseSpend({ DEMO_LLM_PRICE_OUT_PER_MTOK: 'x' }), /DEMO_LLM_PRICE_OUT_PER_MTOK/)
})

test('model calls are kept with their cost and summed by time range', () => {
  let t = 5 * DAY + 1000
  const store = new Store(':memory:', () => t)
  store.addModelCall(MODEL, { input: 100, output: 10, cacheWrite: 1, cacheRead: 2 }, 0.25)
  t += DAY
  store.addModelCall(MODEL, { input: 200, output: 20, cacheWrite: 0, cacheRead: 0 }, 0.5)
  assert.deepEqual(store.spend(), { calls: 2, input: 300, output: 30, cacheWrite: 1, cacheRead: 2, usd: 0.75 })
  assert.deepEqual(store.spend(dayStart(t)), { calls: 1, input: 200, output: 20, cacheWrite: 0, cacheRead: 0, usd: 0.5 })
  assert.equal(store.spend(0, dayStart(t)).calls, 1)
  assert.deepEqual(new Store(':memory:').spend(), { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 })
  store.close()
})

test('a database from before model spend gains the table and keeps its rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'demo-spend-')), 'old.db')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, source TEXT NOT NULL, handle TEXT NOT NULL,
    ip_key TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    action TEXT, to_addr TEXT, amount TEXT, memo TEXT, thought TEXT, verdict TEXT, reason TEXT, outcome TEXT, note TEXT,
    tx_hash TEXT, check_ms INTEGER, win INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, done_at INTEGER, check_rule TEXT
  ); CREATE TABLE flags (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO attempts (created_at, source, handle, ip_key, channel, body) VALUES (1, 'player', 'old', 'k', 'email', 'hi');
  INSERT INTO flags VALUES ('paused', 'kept');`)
  old.close()
  const store = new Store(path)
  assert.equal(store.feedRows([1])[0].handle, 'old')
  assert.equal(store.flag('paused'), 'kept')
  store.addModelCall(MODEL, { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, 0.001)
  store.close()
  const again = new Store(path)
  assert.equal(again.spend().calls, 1)
  again.close()
})

test('the brain records usage before reading the answer: a decision, a refusal, a cut-off and an unreadable answer', async () => {
  const seen: unknown[] = []
  const brain = new HaikuBrain({ apiKey: 'k', system: 's', llm: { model: MODEL, baseUrl: null, proxy: null }, onUsage: u => seen.push(u) })
  const usage = { input_tokens: 900, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const text = (t: string) => [{ type: 'text', text: t }]
  const decision = { action: 'skip', vendor_name: null, to: null, amount: null, memo: '', thought: 'no' }
  const answers = [
    { stop_reason: 'end_turn', usage, content: text(JSON.stringify(decision)) },
    { stop_reason: 'refusal', usage, content: [] },
    { stop_reason: 'max_tokens', usage, content: text('{"action":"pay","to":"0x99') },
    { stop_reason: 'end_turn', usage, content: text('{"action":"wire"}') },
  ]
  let sent: any
  brain['client'].messages.create = (async (body: unknown) => { sent = body; return answers.shift() }) as any
  assert.deepEqual(await brain.decide({ channel: 'email', from: 'x', body: 'hi' }), decision)
  assert.equal(sent.output_config.format.type, 'json_schema')
  assert.equal('parse' in sent.output_config.format, false)
  assert.equal((await brain.decide({ channel: 'email', from: 'x', body: 'hi' })).action, 'skip')
  await assert.rejects(brain.decide({ channel: 'email', from: 'x', body: 'hi' }), /no decision \(stop: max_tokens\)/)
  await assert.rejects(brain.decide({ channel: 'email', from: 'x', body: 'hi' }), /no decision/)
  assert.equal(seen.length, 4)
  assert.deepEqual(seen[2], { input: 900, output: 80, cacheWrite: 0, cacheRead: 0 })
})

const VENDORS: Vendor[] = loadConfig({ DEMO_FAKE: '1' }).vendors

test('the budget pauses the game before the next model call and lifts only its own pause on a new day', async () => {
  const store = new Store(':memory:')
  let spent = 0, calls = 0
  const brain = new FakeBrain(VENDORS), decide = brain.decide.bind(brain)
  brain.decide = item => { calls++; spent += 0.6; return decide(item) }
  const agent = new Agent({ store, brain, payer: new FakePayer(VENDORS, s => parseEther(s), parseEther('0.01')), asset: 'eth', vendors: VENDORS, budget: { usd: 1, spentToday: () => spent } })
  const add = () => store.add({ source: 'player', handle: 'p', ipKey: 'k', channel: 'email', body: 'hello' })
  add(); add(); add()
  await agent.step(); await agent.step()
  assert.equal(calls, 2)
  assert.equal(agent.paused(), null)
  await agent.step()
  assert.equal(calls, 2, 'no call once the budget is reached')
  assert.equal(agent.paused(), BUDGET_PAUSE)
  assert.equal(agent.pausedForBudget(), true)
  spent = 0
  agent.checkBudget()
  assert.equal(agent.paused(), null)
  agent.pause('maintenance'); spent = 5
  agent.checkBudget()
  assert.equal(agent.paused(), 'maintenance')
  spent = 0
  agent.checkBudget()
  assert.equal(agent.paused(), 'maintenance', 'an admin pause is never lifted by the budget')
  store.close()
})

test('the finished day\'s spend is logged once when the UTC day turns', () => {
  let t = 10 * DAY + 5000
  const lines: string[] = [], asked: number[][] = []
  const tick = dailySpendLog((from, to) => { asked.push([from, to]); return { calls: 3, input: 10, output: 2, cacheWrite: 0, cacheRead: 0, usd: 0.0123 } }, m => lines.push(m), () => t)
  tick(); t += 3600_000; tick()
  assert.equal(lines.length, 0)
  t = 11 * DAY + 10; tick(); tick()
  assert.deepEqual(asked, [[10 * DAY, 11 * DAY]])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], `model spend ${dayName(10 * DAY)}: 3 calls, $0.0123 (in 10, out 2, cache write 0, cache read 0 tokens)`)
})
