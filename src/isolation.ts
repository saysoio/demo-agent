// The box faces the internet and holds a prize, so it refuses to start where a bug in it (or in a dependency) could
// reach anything worth more than the pot: the owner key (it can switch the agent to shadow mode), AWS credentials or a
// machine role, sayso's own server settings, or SSH keys. Adapted from sayso's game (apps/game/src/isolation.ts).
// Only names are reported, never a value.
import { lookup } from 'node:dns/promises'
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

export const OWN_SECRETS = new Set(['ANTHROPIC_API_KEY', 'CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET', 'DEMO_SAYSO_API_KEY', 'DEMO_ADMIN_TOKEN', 'DEMO_RPC_URL', 'DEMO_LLM_PROXY'])
const SECRET_LOOKING = [/PRIVATE_?KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /PASSPHRASE/i, /MNEMONIC/i, /SEED/i, /CREDENTIAL/i, /API_?KEY/i,
  /KEY_?ID/i, /^AWS_/i, /^OATHLINE/i, /FORK_URL/i, /RPC(_URL)?$/i, /^SUPABASE_/i, /^TELEGRAM_/i, /(^|_)KEY$/i, /(^|_)PK($|_)/i, /^OWNER_/i]
const HEX_PRIVATE_KEY = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i
// settings that would send traffic somewhere else: every call through a proxy, or the model's calls to another API
const REROUTES = [/^(https?|all|no)_proxy$/i, /^NODE_USE_ENV_PROXY$/i, /^ANTHROPIC_BASE_URL$/i]

export interface Probe {
  env: Record<string, string | undefined>
  uid: number
  user: string
  home: string
  cwd: string
  canRead: (path: string) => boolean
  listHomes: () => string[]
  metadataReachable: () => Promise<boolean>
  /** /proc/net/route, or null where there is none (not Linux) */
  routeTable: () => string | null
  /** the address a name resolves to, or null */
  resolve: (name: string) => Promise<string | null>
  /** which of these ports on this host accept a connection */
  portsReachable: (host: string, ports: number[]) => Promise<number[]>
}

// sayso's own servers and chain copies when they share a machine: the Base API (3000) and its forks (8545, 8565), the
// test-network API (3002) and its fork (8555, whose address holds the Alchemy key)
export const BLOCKED_LOCAL_PORTS: readonly number[] = [3000, 3002, 8545, 8555, 8565]

/** The default route's gateway in /proc/net/route (little-endian hex), as dotted IPv4; null when there is none. */
export function defaultGateway(table: string): string | null {
  for (const line of table.split('\n').slice(1)) {
    const [, dest, gw] = line.trim().split(/\s+/)
    if (dest !== '00000000' || !gw || !/^[0-9A-Fa-f]{8}$/.test(gw) || /^0+$/.test(gw)) continue
    return gw.match(/../g)!.reverse().map(b => parseInt(b, 16)).join('.')
  }
  return null
}

/** Where sayso's servers may answer: this machine, and from inside a container the host behind the bridge gateway. */
async function hostsToProbe(p: Probe): Promise<string[]> {
  const table = p.routeTable()
  const gateway = table === null ? null : defaultGateway(table)
  return [...new Set(['127.0.0.1', gateway, await p.resolve('host.docker.internal')].filter((h): h is string => !!h))]
}

export async function isolationProblems(p: Probe): Promise<string[]> {
  const out: string[] = []
  if (p.uid === 0) out.push('it runs as root; run it as its own user (sayso-demo)')
  if (p.user === 'oathline') out.push('it runs as the sayso server\'s user; run it as its own user (sayso-demo)')
  const set = Object.keys(p.env).filter(k => p.env[k] && !OWN_SECRETS.has(k))
  const named = set.filter(k => SECRET_LOOKING.some(r => r.test(k)))
  if (named.length) out.push(`its settings hold names that are not its own and look like secrets: ${named.sort().join(', ')}`)
  const hex = set.filter(k => !named.includes(k) && HEX_PRIVATE_KEY.test(p.env[k]!))
  if (hex.length) out.push(`its settings hold a value shaped like a private key under ${hex.sort().join(', ')}`)
  const rerouted = set.filter(k => REROUTES.some(r => r.test(k)))
  if (rerouted.length) out.push(`its settings would reroute its traffic: ${rerouted.sort().join(', ')}; route the model with DEMO_LLM_BASE_URL or DEMO_LLM_PROXY`)
  const files = [
    join(p.home, '.aws', 'credentials'), join(p.home, '.aws', 'config'), join(p.home, '.ssh', 'id_ed25519'), join(p.home, '.ssh', 'id_rsa'),
    '/root/.aws/credentials', '/root/.aws/config', '/root/.ssh/id_ed25519', '/opt/oathline/.env', '/opt/oathline/data', '/opt/oathline/app/data', '/etc/oathline/server',
    p.env.AWS_SHARED_CREDENTIALS_FILE, join(p.cwd, '.env.setup'),
    ...p.listHomes().flatMap(u => [join('/home', u, '.aws', 'credentials'), join('/home', u, '.aws', 'config'), join('/home', u, '.ssh', 'id_ed25519'), join('/home', u, '.ssh', 'id_rsa')]),
  ].filter((f): f is string => !!f)
  for (const f of [...new Set(files.map(f => resolve(f)))]) if (p.canRead(f)) out.push(`it can read ${f}`)
  const open: string[] = []
  for (const h of await hostsToProbe(p)) for (const x of await p.portsReachable(h, [...BLOCKED_LOCAL_PORTS])) open.push(`${h}:${x}`)
  if (open.length) out.push(`it can connect to ${open.join(', ')} (a sayso server or chain copy on this machine or its host); firewall them for this user`)
  if (await p.metadataReachable()) out.push('it can reach the cloud metadata service (169.254.169.254), which hands out the machine\'s role')
  return out
}

async function metadataReachable(timeoutMs = 1000): Promise<boolean> {
  const one = (host: string) => fetch(`http://${host}/latest/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '1' }, signal: AbortSignal.timeout(timeoutMs) }).then(() => true, () => false)
  return (await Promise.all(['169.254.169.254', '[fd00:ec2::254]'].map(one))).some(Boolean)
}

export async function reachablePorts(host: string, ports: number[], timeoutMs = 1000): Promise<number[]> {
  const one = (port: number) => new Promise<boolean>(done => {
    const s = connect({ host, port })
    const end = (ok: boolean) => { s.destroy(); clearTimeout(t); done(ok) }
    const t = setTimeout(() => end(false), timeoutMs)
    s.once('connect', () => end(true)).once('error', () => end(false))
  })
  const ok = await Promise.all(ports.map(one))
  return ports.filter((_, i) => ok[i])
}

export function processProbe(): Probe {
  let user = '', uid = -1, home = homedir()
  try { const u = userInfo(); user = u.username; uid = u.uid; home = u.homedir || home } catch { /* no passwd entry */ }
  if (typeof process.getuid === 'function') uid = process.getuid()
  return {
    env: process.env, uid, user, home, cwd: process.cwd(), metadataReachable: () => metadataReachable(),
    portsReachable: (host, ports) => reachablePorts(host, ports),
    routeTable: () => { try { return readFileSync('/proc/net/route', 'utf8') } catch { return null } },
    resolve: name => lookup(name, { family: 4 }).then(r => r.address, () => null),
    listHomes: () => { try { return readdirSync('/home') } catch { return [] } },
    canRead: path => { try { accessSync(path, constants.R_OK); return true } catch { return false } },
  }
}
