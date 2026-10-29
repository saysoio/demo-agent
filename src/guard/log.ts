/** What a log line may say about a failure: the error's class and HTTP status, never its message, which can carry
 *  player or model text, or an RPC URL with a key in it. */
export function errorTag(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? `${name} ${status}` : name
}
