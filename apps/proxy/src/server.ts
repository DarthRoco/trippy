// Local Node host for the handler. Run: npm run dev:proxy (reads the repo-root .env).
import { createServer } from 'node:http'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handle } from './handler.ts'

const port = Number(process.env.PORT ?? 8787)
// Repo-root logs/ (gitignored), one folder for every web port. Absolute: npm runs this from apps/proxy.
const logDir = process.env.DEBUG_LOG_DIR ?? fileURLToPath(new URL('../../../logs', import.meta.url))

// Debug log (Stream D): the web app posts its events here and they are appended to logs/<trip>.jsonl, so test runs
// survive browser storage clears and every dev port ends up in the same folder. Local only: this lives in the Node
// host, not in handler.ts, and takes localhost origins only, so a deployed relay still stores and logs nothing.
async function debugLog(req: { headers: Record<string, any> }, body: Buffer): Promise<number> {
  const origin = String(req.headers.origin ?? '')
  if (!/^http:\/\/localhost:\d+$/.test(origin)) return 403
  try {
    const { trip, events } = JSON.parse(body.toString())
    const file = (trip ? 'trip-' + String(trip).replace(/[^\w-]/g, '-') : 'lobby') + '.jsonl'
    await mkdir(logDir, { recursive: true })
    await appendFile(join(logDir, file), events.map((e: object) => JSON.stringify({ ...e, origin })).join('\n') + '\n')
    return 204
  } catch { return 400 }
}

createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  if (req.url === '/debug-log') {
    const origin = String(req.headers.origin ?? '')
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'content-type', Vary: 'Origin' }
    res.writeHead(req.method === 'POST' ? await debugLog(req, Buffer.concat(chunks)) : 204, cors)
    return res.end()
  }
  const r = await handle(new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  }), process.env).catch(() => new Response('{"error":"upstream failed"}', { status: 502 }))
  res.writeHead(r.status, Object.fromEntries(r.headers))
  res.end(Buffer.from(await r.arrayBuffer()))
}).listen(port, () => console.log(`proxy on http://localhost:${port}`))
