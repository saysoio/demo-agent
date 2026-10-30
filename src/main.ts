// Starts the box: settings, the isolation check, the wallet, the agent loop and the server.
//   DEMO_FAKE=1 DEMO_DEV=1 npm start   local run with a scripted brain and a pretend sayso; no keys, no network
import { join } from 'node:path'
import { parseUnits } from 'viem'
import { toAccount } from 'viem/accounts'
import { Agent } from './agent.ts'
import { FakeBrain, HaikuBrain, systemPrompt } from './brain.ts'
import { decimalsFor, loadConfig, type LlmSettings } from './config.ts'
import { directory } from './directory.ts'
import { isolationProblems, processProbe } from './isolation.ts'
import { proxyTrustProblem } from './guard/index.ts'
import { loadRules } from './rules.ts'
import { makeServer } from './server.ts'
import { callCost, dailySpendLog, dayStart, type Usage } from './spend.ts'
import { Store } from './store.ts'
import { FakePayer, SaysoPayer, type Payer } from './wallet.ts'

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`)

// names the route only: the URLs stay out of the log (the proxy one may hold a password)
function modelRoute(llm: LlmSettings): string {
  const via = [llm.baseUrl && 'gateway', llm.proxy && 'proxy'].filter(Boolean)
  return via.length ? `, model via ${via.join(' and ')}` : ''
}

async function main() {
  const cfg = loadConfig()
  const problems = await isolationProblems(processProbe())
  if (problems.length) {
    if (!cfg.dev) throw new Error(`refusing to start:\n- ${problems.join('\n- ')}`)
    log(`isolation (ignored in dev):\n- ${problems.join('\n- ')}`)
  }
  if (cfg.fake && !cfg.dev) throw new Error('DEMO_FAKE=1 is for local runs only (set DEMO_DEV=1 too)')
  if (cfg.dev && !cfg.fake && cfg.network === 'base') throw new Error('DEMO_DEV=1 turns the isolation check off; never on the real pot')
  const proxy = proxyTrustProblem(cfg)
  if (proxy) throw new Error(proxy)

  const signed = loadRules(cfg)
  const store = new Store(join(cfg.dataDir, 'demo.db'))
  const decimals = decimalsFor(cfg.asset)
  let payer: Payer
  if (cfg.fake) payer = new FakePayer(cfg.vendors, s => parseUnits(s, decimals), parseUnits('0.01', decimals))
  else {
    const { CdpClient } = await import('@coinbase/cdp-sdk')
    const cdp = new CdpClient(cfg.secrets.cdp!)
    // the account was made and registered by `npm run setup`; it is only looked up here
    const acct = await cdp.evm.getAccount({ name: cfg.cdpAccountName })
    payer = new SaysoPayer(cfg, toAccount(acct as any))
  }
  const onUsage = (u: Usage) => store.addModelCall(cfg.llm.model, u, callCost(u, cfg.spend))
  const brain = cfg.fake ? new FakeBrain(cfg.vendors) : await HaikuBrain.create({ apiKey: cfg.secrets.anthropic, llm: cfg.llm, onUsage, system: systemPrompt({ agentName: cfg.agentName, asset: cfg.asset, directory: directory(cfg.vendors) }) })
  const budget = cfg.spend.budgetUsd === null ? undefined : { usd: cfg.spend.budgetUsd, spentToday: () => store.spend(dayStart(Date.now())).usd }

  const maxPerPayment = cfg.maxPerPayment ? parseUnits(cfg.maxPerPayment, decimals) : undefined
  const agent = new Agent({ store, brain, payer, asset: cfg.asset, vendors: cfg.vendors, maxPerPayment, budget, log })
  agent.start({ tickMs: cfg.tickMs, vendorInvoiceEveryMs: cfg.vendorInvoiceEveryMs })
  const server = makeServer({ cfg, store, agent, payer, signed, log })
  server.listen(cfg.port, cfg.host, () => log(`demo-agent on http://${cfg.host}:${cfg.port}/game/ (${cfg.network}, ${cfg.asset}, wallet ${payer.address}${cfg.fake ? ', FAKE' : modelRoute(cfg.llm)}${agent.paused() ? `, PAUSED: ${agent.paused()}` : ''})`))

  const spendLog = setInterval(dailySpendLog((from, to) => store.spend(from, to), log), 60_000)

  const bye = () => { clearInterval(spendLog); agent.stop(); server.close(); store.close(); process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
}

main().catch(e => { console.error(`demo-agent failed: ${(e as Error).message}`); process.exit(1) })
