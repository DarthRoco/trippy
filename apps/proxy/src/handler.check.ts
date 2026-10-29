// Run: node apps/proxy/src/handler.check.ts   (no network: cases are rejected before any upstream call, or fetch is stubbed)
import assert from 'node:assert/strict'
import { handle, originOk } from './handler.ts'

const env = { ALLOWED_ORIGINS: 'http://localhost:5173' }
const call = (path: string, init: { origin?: string; headers?: Record<string, string>; body?: unknown; method?: string } = {}) =>
  handle(new Request('http://x' + path, {
    method: init.method ?? 'POST',
    headers: { Origin: init.origin ?? 'http://localhost:5173', 'X-Trippy-Session': 's1', ...init.headers },
    body: init.method === 'OPTIONS' ? undefined : JSON.stringify(init.body ?? {}),
  }), env)

assert.equal((await call('/llm', { origin: 'https://evil.example' })).status, 403)
assert.equal((await call('/llm', { method: 'OPTIONS' })).status, 204)
assert.equal((await call('/nope')).status, 404)
assert.equal((await call('/maps/places', { headers: { 'X-Goog-FieldMask': 'places.reviews' } })).status, 400)
assert.equal((await call('/maps/places', { headers: { 'X-Goog-FieldMask': '*' } })).status, 400)
assert.equal((await call('/llm', { body: { model: 'some/expensive-model' } })).status, 400)
assert.equal((await call('/maps/details', { headers: { 'X-Goog-FieldMask': 'displayName' }, body: { id: '../../v1/places:searchText' } })).status, 400)
assert.equal((await call('/maps/details', { headers: { 'X-Goog-FieldMask': 'reviews' }, body: { id: 'ChIJv5l0UP7I5zsR6kft0H7sJ0E' } })).status, 400)
assert.equal((await call('/search', { body: {} })).status, 400)

// Per-session cap: search allows 20 per session per day (calls above already used 1).
let last = 0
for (let i = 0; i < 25; i++) last = (await call('/search', { body: {} })).status
assert.equal(last, 429)
// Outing planner: its paths, fields and model are allowed and forwarded; anything else is still refused. fetch is stubbed (no network).
const realFetch = globalThis.fetch
const sent: { url: string; init: any }[] = []
globalThis.fetch = (async (url: any, init: any) => { sent.push({ url: String(url), init }); return new Response('{}') }) as typeof fetch
const NEARBY = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.rating,places.userRatingCount,' +
  'places.priceLevel,places.businessStatus,places.regularOpeningHours,places.outdoorSeating,places.parkingOptions'
const MATRIX = 'originIndex,destinationIndex,duration,condition'
assert.equal((await call('/maps/nearby', { headers: { 'X-Goog-FieldMask': NEARBY }, body: { includedTypes: ['park'] } })).status, 200)
assert.equal(sent.at(-1)!.url, 'https://places.googleapis.com/v1/places:searchNearby')
assert.equal(sent.at(-1)!.init.headers['X-Goog-FieldMask'], NEARBY)
assert.equal((await call('/maps/matrix', { headers: { 'X-Goog-FieldMask': MATRIX }, body: { travelMode: 'WALK' } })).status, 200)
assert.equal(sent.at(-1)!.url, 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix')
assert.equal(sent.at(-1)!.init.headers['X-Goog-FieldMask'], MATRIX)
const grid = (n: number) => Array.from({ length: n }, () => ({}))
assert.equal((await call('/maps/matrix', { headers: { 'X-Goog-FieldMask': MATRIX }, body: { origins: grid(10), destinations: grid(10) } })).status, 200)
assert.equal((await call('/maps/matrix', { headers: { 'X-Goog-FieldMask': MATRIX }, body: { origins: grid(11), destinations: grid(10) } })).status, 400)
assert.equal((await call('/maps/places', { headers: { 'X-Goog-FieldMask': 'places.location,places.displayName' }, body: { textQuery: 'Koramangala' } })).status, 200)
for (const [path, mask] of [['/maps/nearby', NEARBY + ',places.reviews'], ['/maps/matrix', MATRIX + ',localizedValues'], ['/maps/matrix', '*']])
  assert.equal((await call(path, { headers: { 'X-Goog-FieldMask': mask } })).status, 400, path + ' ' + mask)
const llm = (model: string) => call('/llm', { body: { model, messages: [] } })
assert.equal((await llm('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B')).status, 200)
assert.equal((await llm('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8')).status, 400)
// Planner web searches: same Tavily call as /search, but their own allowance (the trip feature's 20 are already used up here).
assert.equal((await call('/search/evidence', { body: {} })).status, 400)
assert.equal((await call('/search/evidence', { body: { query: 'Third Wave Indiranagar quiet' } })).status, 200)
assert.equal(sent.at(-1)!.url, 'https://api.tavily.com/search')
assert.equal(JSON.parse(sent.at(-1)!.init.body).max_results, 5)
assert.equal((await call('/search', { body: { query: 'x' } })).status, 429)
let ev = 0
for (let i = 0; i < 70; i++) ev = (await call('/search/evidence', { body: { query: 'x' } })).status
assert.equal(ev, 429) // 30 a session
assert.equal((await call('/search/evidence', { body: { query: 'x' }, headers: { 'X-Trippy-Session': 's2' } })).status, 200)
globalThis.fetch = realFetch
// Preview-URL pattern: one subdomain label of the project, https only.
const list = 'https://trippy.pages.dev,https://*.trippy.pages.dev'
for (const o of ['https://trippy.pages.dev', 'https://abc123.trippy.pages.dev', 'https://stream-b.trippy.pages.dev']) assert.ok(originOk(o, list), o)
for (const o of ['http://abc.trippy.pages.dev', 'https://evil.pages.dev', 'https://a.b.trippy.pages.dev', 'https://.trippy.pages.dev',
  'https://eviltrippy.pages.dev', 'https://x.trippy.pages.dev.evil.com', 'http://localhost:5173']) assert.ok(!originOk(o, list), o)
// Caps Durable Object (worker.ts) on node:sqlite standing in for DO storage; handler -> env.CAPS -> 429 across "restarts".
const { Caps } = await import('./worker.ts')
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(':memory:')
const storage = { sql: { exec: (q: string, ...p: unknown[]) => { const rows = db.prepare(q).all(...p as any[]); return { toArray: () => rows } } } }
const caps = new Caps({ storage })
const CAPS = { idFromName: () => 'id', get: () => ({ fetch: (u: string, init: RequestInit) => caps.fetch(new Request(u, init)) }) }
const withCaps = (s: string) => handle(new Request('http://x/search', { method: 'POST', body: '{}',
  headers: { Origin: 'http://localhost:5173', 'X-Trippy-Session': s } }), { ...env, CAPS })
for (let i = 0; i < 20; i++) assert.equal((await withCaps('a')).status, 400) // session cap 20: counted, then rejected by body check
assert.equal((await withCaps('a')).status, 429)
assert.equal((await withCaps('b')).status, 400) // other session unaffected
console.log('proxy guards ok')
