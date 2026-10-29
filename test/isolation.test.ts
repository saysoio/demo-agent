import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BLOCKED_LOCAL_PORTS, defaultGateway, isolationProblems, type Probe } from '../src/isolation.ts'

// /proc/net/route inside a Docker container: the default route goes through the bridge gateway 172.30.0.1
const ROUTES = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t01001EAC\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t00001EAC\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
`

function probe(o: Partial<Probe> = {}): Probe {
  return {
    env: {}, uid: 1000, user: 'sayso-demo', home: '/nonexistent', cwd: '/app', canRead: () => false, listHomes: () => [],
    metadataReachable: async () => false, routeTable: () => null, resolve: async () => null, portsReachable: async () => [], ...o,
  }
}

test('the default gateway is read from the route table', () => {
  assert.equal(defaultGateway(ROUTES), '172.30.0.1')
  assert.equal(defaultGateway(ROUTES.split('\n').filter(l => !l.includes('\t00000000\t01')).join('\n')), null)
  assert.equal(defaultGateway(''), null)
})

test('sayso ports are probed on loopback, the gateway and host.docker.internal', async () => {
  const asked: string[] = []
  const p = probe({
    routeTable: () => ROUTES,
    resolve: async name => (name === 'host.docker.internal' ? '192.168.65.254' : null),
    portsReachable: async (host, ports) => { asked.push(host); assert.deepEqual(ports, [...BLOCKED_LOCAL_PORTS]); return host === '172.30.0.1' ? [3000, 8545] : [] },
  })
  const problems = await isolationProblems(p)
  assert.deepEqual(asked, ['127.0.0.1', '172.30.0.1', '192.168.65.254'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /172\.30\.0\.1:3000, 172\.30\.0\.1:8545/)
})

test('without a route table only loopback is probed, quietly', async () => {
  const asked: string[] = []
  assert.deepEqual(await isolationProblems(probe({ portsReachable: async h => { asked.push(h); return [] } })), [])
  assert.deepEqual(asked, ['127.0.0.1'])
})

test('settings that reroute traffic are refused, in any case', async () => {
  const env = { https_proxy: 'http://p:3128', HTTP_PROXY: 'http://p', All_Proxy: 'socks5://p', NO_PROXY: 'x', NODE_USE_ENV_PROXY: '1', ANTHROPIC_BASE_URL: 'https://x', DEMO_LLM_PROXY: 'http://p' }
  const [problem, ...rest] = await isolationProblems(probe({ env }))
  assert.deepEqual(rest, [])
  assert.match(problem, /reroute/)
  const named = problem.split(': ')[1].split(';')[0].split(', ')
  assert.deepEqual(named, ['ANTHROPIC_BASE_URL', 'All_Proxy', 'HTTP_PROXY', 'NODE_USE_ENV_PROXY', 'NO_PROXY', 'https_proxy'])
})
