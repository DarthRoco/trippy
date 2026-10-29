// Stateless backend. Holds the Google, Tavily and Nebius keys (from env). Stores and logs no user data (Q21, Q33).
// Guards (B3): origin check, field-mask allowlist, model allowlist, global + per-session daily caps.
// Plain fetch(Request) -> Response so it runs on Node now and Workers or a container later (DECISIONS, check 6).
export type Env = Record<string, any> // strings from env, plus the optional CAPS Durable Object binding on Workers

const GOOGLE_URL: Record<string, string> = {
  '/maps/routes': 'https://routes.googleapis.com/directions/v2:computeRoutes',
  '/maps/places': 'https://places.googleapis.com/v1/places:searchText',
  '/maps/details': 'https://places.googleapis.com/v1/places/', // + place id, GET
  '/maps/autocomplete': 'https://places.googleapis.com/v1/places:autocomplete',
  '/maps/nearby': 'https://places.googleapis.com/v1/places:searchNearby', // outing planner
  '/maps/matrix': 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', // outing planner
}
// The only Google fields a client may ask for. Masks set the billed SKU (B2).
const FIELDS = new Set([
  'routes.duration', 'routes.distanceMeters', 'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters', 'routes.legs.steps.navigationInstruction.instructions',
  'routes.legs.duration', 'routes.legs.distanceMeters', 'routes.legs.polyline.encodedPolyline', // trip model v2: one entry per leg
  'places.id', 'places.displayName', 'places.location', 'places.rating', 'places.userRatingCount',
  'places.priceLevel', 'places.currentOpeningHours.openNow', 'places.primaryType', 'places.servesVegetarianFood', 'routingSummaries',
  // Place Details (no 'places.' prefix): Enterprise + Atmosphere because of parkingOptions / reservable.
  'displayName', 'formattedAddress', 'nationalPhoneNumber', 'regularOpeningHours.weekdayDescriptions',
  'currentOpeningHours.openNow', 'priceLevel', 'priceRange', 'rating', 'userRatingCount', 'websiteUri', 'parkingOptions', 'reservable',
  // Autocomplete (New), for the From / To boxes.
  'suggestions.placePrediction.placeId', 'suggestions.placePrediction.structuredFormat.mainText.text',
  'suggestions.placePrediction.structuredFormat.secondaryText.text',
  // Outing planner: nearby search (hours, types, parking) and the route matrix (no 'routes.' prefix).
  'places.formattedAddress', 'places.types', 'places.businessStatus', 'places.regularOpeningHours', 'places.outdoorSeating',
  'places.parkingOptions', 'originIndex', 'destinationIndex', 'duration', 'condition',
])
const MODELS = new Set([
  'nvidia/nemotron-3-super-120b-a12b', 'nvidia/Nemotron-3-Ultra-550b-a55b',
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', // only the outing planner's request parser uses it
])
// Daily caps per group: [all users, one session].
// suggest = autocomplete: one call per pause in typing, so its own larger bucket.
// maps 400 a session: a 4 h drive refreshes its route every 5 min (~50 calls) before any search (2026-10-16, Nashik ride).
const CAPS: Record<string, [number, number]> = { maps: [2000, 400], suggest: [5000, 300], search: [200, 20], llm: [3000, 200],
  evidence: [100, 30] } // the outing planner's web searches, apart from the trip feature's 20 a session (user: 100 a day)

// Counters: env.CAPS (a Durable Object, see worker.ts) when present, so they survive restarts and are shared by all
// Worker instances; otherwise in memory (local Node host).
let day = ''
const used = new Map<string, number>()

async function overCap(group: string, session: string, env: Env): Promise<boolean> {
  const [all, one] = CAPS[group]
  if (env.CAPS) {
    const r = await env.CAPS.get(env.CAPS.idFromName('caps')).fetch('http://caps/', { method: 'POST', body: JSON.stringify({ group, session, all, one }) })
    return ((await r.json()) as { over: boolean }).over
  }
  const today = new Date().toISOString().slice(0, 10)
  if (today !== day) { day = today; used.clear() }
  const a = (used.get(group) ?? 0) + 1, s = (used.get(group + ':' + session) ?? 0) + 1
  if (a > all || s > one) return true
  used.set(group, a)
  used.set(group + ':' + session, s)
  return false
}

// ALLOWED_ORIGINS is a comma list. An entry like https://*.trippy.pages.dev also takes one subdomain label (Pages preview URLs).
export const originOk = (origin: string, list: string) => list.split(',').some(e => e === origin || (e.startsWith('https://*.')
  && origin.startsWith('https://') && origin.endsWith(e.slice(9)) && /^[a-z0-9-]+$/.test(origin.slice(8, origin.length - e.length + 9))))

const json = (data: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

export async function handle(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin') ?? ''
  if (!originOk(origin, env.ALLOWED_ORIGINS ?? 'http://localhost:5173')) return json({ error: 'origin not allowed' }, 403)
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'content-type,x-trippy-session,x-goog-fieldmask',
    'Access-Control-Max-Age': '600' } })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405, cors)

  const path = new URL(req.url).pathname
  const group = GOOGLE_URL[path] ? 'maps' : path === '/search' || path === '/search/evidence' ? 'search' : path === '/llm' ? 'llm' : ''
  if (!group) return json({ error: 'not found' }, 404, cors)
  const bucket = path === '/maps/autocomplete' ? 'suggest' : path === '/search/evidence' ? 'evidence' : group
  if (await overCap(bucket, req.headers.get('X-Trippy-Session') ?? 'none', env)) return json({ error: 'daily limit reached' }, 429, cors)
  let body: any
  try { body = await req.json() } catch { return json({ error: 'bad json' }, 400, cors) }

  let up: Response
  if (group === 'maps') {
    const mask = req.headers.get('X-Goog-FieldMask') ?? ''
    if (!mask || mask.split(',').some(f => !FIELDS.has(f))) return json({ error: 'field mask not allowed' }, 400, cors)
    const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_SERVER_KEY ?? '', 'X-Goog-FieldMask': mask }
    // The matrix bills per element (up to 625 a call); the planner sends at most 8 x 8.
    if (path === '/maps/matrix' && (body.origins?.length ?? 0) * (body.destinations?.length ?? 0) > 100) {
      return json({ error: 'matrix too large' }, 400, cors)
    }
    if (path === '/maps/details') {
      if (typeof body.id !== 'string' || !/^[\w-]{10,300}$/.test(body.id)) return json({ error: 'bad place id' }, 400, cors)
      up = await fetch(GOOGLE_URL[path] + body.id, { headers })
    } else {
      up = await fetch(GOOGLE_URL[path], { method: 'POST', body: JSON.stringify(body), headers })
    }
  } else if (group === 'search') {
    if (typeof body.query !== 'string') return json({ error: 'query required' }, 400, cors)
    up = await fetch('https://api.tavily.com/search', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query: body.query.slice(0, 300), max_results: 5, search_depth: 'basic' }) })
  } else {
    if (!MODELS.has(body.model)) return json({ error: 'model not allowed' }, 400, cors)
    body.stream = false
    body.max_tokens = Math.min(Number(body.max_tokens) || 4096, 8192)
    up = await fetch('https://api.tokenfactory.nebius.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NEBIUS_API_KEY}` } })
  }
  return new Response(up.body, { status: up.status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
