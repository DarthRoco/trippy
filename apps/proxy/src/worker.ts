// Cloudflare Workers host for handler.ts (wrangler.toml: main). Keys arrive as Worker secrets in env.
import { handle } from './handler.ts'

export default {
  fetch: (req: Request, env: object) =>
    handle(req, env).catch(() => new Response('{"error":"upstream failed"}', { status: 502, headers: { 'Content-Type': 'application/json' } })),
}

// Daily cap counters for the whole proxy: one SQLite-backed Durable Object, so they survive restarts and are shared by every
// Worker instance. Counts only (group, session id), nothing about users. One call per proxied request.
// ponytail: one global instance, a few ms per request; fine for our caps (~10k calls/day), shard by group if it ever matters.
export class Caps {
  sql: any
  constructor(state: any) {
    this.sql = state.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS used (day TEXT, k TEXT, n INTEGER, PRIMARY KEY (day, k))')
  }
  async fetch(req: Request) {
    const { group, session, all, one } = await req.json() as { group: string; session: string; all: number; one: number }
    const day = new Date().toISOString().slice(0, 10)
    const keys = [group, group + ':' + session]
    const n = (k: string): number => this.sql.exec('SELECT n FROM used WHERE day = ? AND k = ?', day, k).toArray()[0]?.n ?? 0
    if (n(keys[0]) + 1 > all || n(keys[1]) + 1 > one) return Response.json({ over: true })
    for (const k of keys) this.sql.exec('INSERT INTO used VALUES (?, ?, 1) ON CONFLICT (day, k) DO UPDATE SET n = n + 1', day, k)
    this.sql.exec('DELETE FROM used WHERE day <> ?', day)
    return Response.json({ over: false })
  }
}
