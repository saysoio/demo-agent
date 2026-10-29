import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig, MODEL, parseLlm, parseMaxPerPayment, parseTrustedProxies } from '../src/config.ts'
import { OWN_SECRETS } from '../src/isolation.ts'

test('llm settings default to the direct API and the built-in model', () => {
  assert.deepEqual(parseLlm({}, false), { model: MODEL, baseUrl: null, proxy: null })
  assert.deepEqual(parseLlm({ DEMO_LLM_BASE_URL: ' ', DEMO_LLM_PROXY: '' }, false), { model: MODEL, baseUrl: null, proxy: null })
})

test('llm settings accept a gateway, a proxy with a login, and a model id', () => {
  const llm = parseLlm({ DEMO_LLM_BASE_URL: 'https://gw.example.com/anthropic/', DEMO_LLM_PROXY: 'http://u:p@proxy.example.com:3128', DEMO_LLM_MODEL: 'claude-haiku-5-5' }, false)
  assert.deepEqual(llm, { model: 'claude-haiku-5-5', baseUrl: 'https://gw.example.com/anthropic', proxy: 'http://u:p@proxy.example.com:3128' })
  assert.equal(parseLlm({ DEMO_LLM_PROXY: 'https://proxy.example.com' }, false).proxy, 'https://proxy.example.com')
})

test('the gateway must be https, except in dev', () => {
  assert.throws(() => parseLlm({ DEMO_LLM_BASE_URL: 'http://gw.example.com' }, false), /DEMO_LLM_BASE_URL must start with https:/)
  assert.equal(parseLlm({ DEMO_LLM_BASE_URL: 'http://127.0.0.1:9000' }, true).baseUrl, 'http://127.0.0.1:9000')
  assert.throws(() => parseLlm({ DEMO_LLM_BASE_URL: 'ftp://gw.example.com' }, true), /DEMO_LLM_BASE_URL/)
  assert.throws(() => parseLlm({ DEMO_LLM_BASE_URL: 'not a url' }, false), /DEMO_LLM_BASE_URL is not a valid URL/)
})

test('the gateway URL may not hold credentials', () => {
  assert.throws(() => parseLlm({ DEMO_LLM_BASE_URL: 'https://user:pw@gw.example.com' }, false), /must not hold credentials/)
  assert.throws(() => parseLlm({ DEMO_LLM_BASE_URL: 'https://user@gw.example.com' }, false), /must not hold credentials/)
})

test('the proxy must be http or https, and errors never show its value', () => {
  assert.throws(() => parseLlm({ DEMO_LLM_PROXY: 'socks5://u:hunter2@proxy.example.com' }, false), e => {
    assert.match((e as Error).message, /DEMO_LLM_PROXY must start with/)
    assert.doesNotMatch((e as Error).message, /hunter2/)
    return true
  })
  assert.ok(OWN_SECRETS.has('DEMO_LLM_PROXY'))
})

test('the model id must be plain', () => {
  for (const bad of ['claude haiku', 'claude/haiku', '-claude', 'x'.repeat(101), 'claude\nhaiku']) {
    assert.throws(() => parseLlm({ DEMO_LLM_MODEL: bad }, false), /DEMO_LLM_MODEL/, bad)
  }
  assert.equal(parseLlm({ DEMO_LLM_MODEL: 'claude-haiku-5-5-20261001' }, false).model, 'claude-haiku-5-5-20261001')
})

test('trusted proxies are exact IP addresses, none by default', () => {
  assert.deepEqual(parseTrustedProxies(undefined), [])
  assert.deepEqual(parseTrustedProxies(' 172.30.0.2, FD00::2 ,'), ['172.30.0.2', 'fd00::2'])
  for (const bad of ['172.30.0.0/24', 'proxy.local', '172.30.0.2,300.1.1.1']) assert.throws(() => parseTrustedProxies(bad), /DEMO_TRUSTED_PROXY/)
})

test('the per-payment cap is required on base and must be a plain decimal', () => {
  assert.equal(parseMaxPerPayment(undefined, 'base-sepolia'), null)
  assert.equal(parseMaxPerPayment(' 5 ', 'base'), '5')
  assert.throws(() => parseMaxPerPayment(undefined, 'base'), /DEMO_MAX_PER_PAYMENT is required on base/)
  assert.throws(() => parseMaxPerPayment('', 'base'), /required/)
  for (const bad of ['5 usdc', '-1', '1e3']) assert.throws(() => parseMaxPerPayment(bad, 'base-sepolia'), /plain decimal/, bad)
  assert.throws(() => loadConfig({ DEMO_FAKE: '1', DEMO_NETWORK: 'base' }), /DEMO_MAX_PER_PAYMENT/)
  assert.equal(loadConfig({ DEMO_FAKE: '1', DEMO_NETWORK: 'base', DEMO_MAX_PER_PAYMENT: '5' }).maxPerPayment, '5')
})

test('the agent name comes from the settings, Penny by default', () => {
  assert.equal(loadConfig({ DEMO_FAKE: '1' }).agentName, 'Penny')
  assert.equal(loadConfig({ DEMO_FAKE: '1', DEMO_AGENT_NAME: ' Max ' }).agentName, 'Max')
})
