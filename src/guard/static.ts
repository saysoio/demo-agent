// Which files under public/ the page may be served from: /game/ only, no way out of it, and only these types.
import { extname, normalize } from 'node:path'

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

/** The file under public/ for a /game/ URL path, with its content type; null for anything else. */
export function staticPath(urlPath: string): { rel: string; type: string } | null {
  if (!urlPath.startsWith('/game/')) return null
  const rel = normalize(urlPath === '/game/' ? 'game/index.html' : urlPath.slice(1))
  const type = TYPES[extname(rel)]
  return rel.includes('..') || !rel.startsWith('game/') || !type ? null : { rel, type }
}
