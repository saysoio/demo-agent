import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HaikuBrain, clientOptions } from '../src/brain.ts'
import { ANTHROPIC_API, MODEL, type LlmSettings } from '../src/config.ts'

const llm = (o: Partial<LlmSettings> = {}): LlmSettings => ({ model: MODEL, baseUrl: null, proxy: null, ...o })

test('the client gets the gateway as its base URL, and no fetch options without a proxy', () => {
  const opts = clientOptions({ apiKey: 'k', baseUrl: 'https://gw.example.com' })
  assert.equal(opts.baseURL, 'https://gw.example.com')
  assert.equal(opts.fetchOptions, undefined)
  // always set, so ANTHROPIC_BASE_URL in the environment is never read
  assert.equal(clientOptions({ apiKey: 'k', baseUrl: null }).baseURL, ANTHROPIC_API)
})

test('the brain is built with the gateway base URL and the configured model', async () => {
  const brain = await HaikuBrain.create({ apiKey: 'k', system: 's', llm: llm({ baseUrl: 'https://gw.example.com', model: 'claude-other-1' }) })
  assert.equal(brain['client'].baseURL, 'https://gw.example.com')
  assert.equal(brain.name, 'claude-other-1')
  const direct = new HaikuBrain({ apiKey: 'k', system: 's', llm: llm() })
  assert.equal(direct['client'].baseURL, ANTHROPIC_API)
})
