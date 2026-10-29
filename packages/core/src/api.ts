// Calls to our backend (apps/proxy). Keys live there, never in client code.
// session: one per page load; the proxy caps calls per session (H2). Test runners start a new one per request.
// onCall: the debug log's hook (apps/web/src/log.ts); every call passes through post, so none is missed.
export type CallLog = { path: string; headers: Record<string, string>; body: unknown; status: number; ms: number; data?: unknown; error?: string }
export const api = { base: 'http://localhost:8787', session: crypto.randomUUID(), onCall: undefined as ((e: CallLog) => void) | undefined }

export async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const t0 = Date.now()
  const e: CallLog = { path, headers, body, status: 0, ms: 0 }
  try {
    const r = await fetch(api.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trippy-Session': api.session, ...headers },
      body: JSON.stringify(body),
    })
    e.status = r.status
    const data = await r.json().catch(() => ({}))
    e.data = data
    if (!r.ok) throw new Error(`${path} ${r.status}: ${data.error?.message ?? data.error ?? r.statusText}`)
    return data as T
  } catch (err) {
    e.error = String(err)
    throw err
  } finally {
    e.ms = Date.now() - t0
    api.onCall?.(e)
  }
}
