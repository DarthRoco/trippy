import { cachedPost as post } from './cache.ts'
import { periodsToIntervals } from './hours.ts'
import type { LatLng, PlannerPlace, StopType } from './types.ts'

const ll = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng })

// Field mask limits the response to what the planner uses. Billing depends on the fields requested.
const FIELD_MASK = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.types', 'places.primaryType',
  'places.rating', 'places.userRatingCount', 'places.priceLevel', 'places.businessStatus', 'places.regularOpeningHours',
  'places.outdoorSeating', 'places.parkingOptions'].join(',')

// Map stop types to Places (New) included types.
export const STOP_TYPE_TO_PLACES: Record<StopType, string[]> = {
  coffee: ['cafe', 'coffee_shop'],
  work: ['cafe', 'coworking_space', 'library'],
  dinner: ['restaurant'],
  lunch: ['restaurant'],
  bar: ['bar'],
  snack: ['bakery', 'ice_cream_shop'],
  walk: ['park'],
  sunset: ['park'],
  shopping: ['shopping_mall', 'clothing_store', 'gift_shop', 'book_store', 'jewelry_store'], // only when the user did not say what to buy
}

export const PRIMARY_BONUS = 1.3 // a place whose main category fits the stop outranks one that only carries the tag
export const BARS = new Set(['bar', 'cocktail_bar', 'wine_bar', 'night_club', 'pub'])
export const NOT_OUTDOOR = new Set(['hindu_temple', 'place_of_worship', 'amusement_center', 'hospital', 'medical_center', 'medical_clinic', 'doctor'])

// Places types are loose (a pizzeria can carry "cafe"), so each stop type also filters on the returned types:
// keep a place with any `require` type and none of the `exclude` types.
export const STOP_FILTERS: Partial<Record<StopType, [Set<string>, Set<string>]>> = {
  coffee: [new Set(['coffee_shop', 'cafe', 'tea_house']), BARS],
  work: [new Set(['cafe', 'coffee_shop', 'coworking_space', 'library']), BARS],
  sunset: [new Set(['park']), NOT_OUTDOOR],
  walk: [new Set(['park']), NOT_OUTDOOR],
}

export function toPlace(raw: any): PlannerPlace {
  const parking = raw.parkingOptions
  return {
    place_id: raw.id,
    name: raw.displayName?.text ?? '',
    location: { lat: raw.location.latitude, lng: raw.location.longitude },
    address: raw.formattedAddress ?? '',
    rating: raw.rating,
    reviews: raw.userRatingCount ?? 0,
    price: raw.priceLevel?.replace('PRICE_LEVEL_', ''), // INEXPENSIVE, MODERATE, ... as in google.ts; read by the budget
    types: raw.types ?? [],
    type: raw.primaryType,
    open: periodsToIntervals(raw.regularOpeningHours?.periods),
    outdoor_seating: raw.outdoorSeating,
    parking: parking && Object.keys(parking).length ? Object.values(parking).some(Boolean) : undefined, // undefined = Google gave none
    attributes: {},
    evidence: [],
  }
}

// A square around center, radiusM from it on each side: Text Search restricts to a rectangle only, not a circle.
function box(center: LatLng, radiusM: number) {
  const dLat = radiusM / 111_320, dLng = dLat / Math.cos((center.lat * Math.PI) / 180)
  return { rectangle: { low: ll({ lat: center.lat - dLat, lng: center.lng - dLng }), high: ll({ lat: center.lat + dLat, lng: center.lng + dLng }) } }
}

// Places for the user's words in the area, best match first. Google's text search wants every word, so "demi fine or
// semi precious statement ring" finds nothing: each alternative is searched on its own and the answers are taken in
// turn (first of each, then second of each, ...), each place once.
async function textSearch(query: string, center: LatLng, radiusM: number): Promise<any[]> {
  const parts = query.split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i).filter(Boolean)
  const lists = await Promise.all(parts.map(async q => (await post<any>('/maps/places',
    { textQuery: q, maxResultCount: 20, locationRestriction: box(center, radiusM) }, { 'X-Goog-FieldMask': FIELD_MASK })).places ?? []))
  const seen = new Set<string>(), out: any[] = []
  for (let i = 0; i < 20; i++) for (const l of lists) if (l[i] && !seen.has(l[i].id)) { seen.add(l[i].id); out.push(l[i]) }
  return out
}

// Search, drop closed or off-type places, and keep the top n by rating and review count. With a query (the user's words
// for what to buy) it is a text search in the area instead, and Google's order, best match to the words first, is kept.
export async function findCandidates(stopType: StopType, center: LatLng, radiusM = 1500, n = 8, query?: string): Promise<PlannerPlace[]> {
  const res = query ? { places: await textSearch(query, center, radiusM) } : await post<any>('/maps/nearby', {
    includedTypes: STOP_TYPE_TO_PLACES[stopType],
    maxResultCount: 20,
    locationRestriction: { circle: { center: ll(center), radius: radiusM } },
  }, { 'X-Goog-FieldMask': FIELD_MASK })
  const [require, exclude] = STOP_FILTERS[stopType] ?? [new Set<string>(), new Set<string>()]
  const score = (p: PlannerPlace) => (p.rating || 0) * Math.min(p.reviews ?? 0, 500) ** 0.25 * (p.type && require.has(p.type) ? PRIMARY_BONUS : 1)
  return (res.places ?? [])
    .filter((r: any) => {
      const types: string[] = r.types ?? []
      return (r.businessStatus ?? 'OPERATIONAL') === 'OPERATIONAL' && !(require.size && !types.some(t => require.has(t))) && !types.some(t => exclude.has(t))
    })
    .map(toPlace)
    .sort((a: PlannerPlace, b: PlannerPlace) => (query ? 0 : score(b) - score(a)))
    .slice(0, n)
}

// The place the user named: Google's best match for the name near the area. null = none found, or it no longer trades.
export async function findPlace(name: string, center: LatLng): Promise<PlannerPlace | null> {
  const res = await post<any>('/maps/places', { textQuery: name, maxResultCount: 1, locationBias: { circle: { center: ll(center), radius: 5000 } } },
    { 'X-Goog-FieldMask': FIELD_MASK })
  const p = res.places?.[0]
  return p && (p.businessStatus ?? 'OPERATIONAL') === 'OPERATIONAL' ? toPlace(p) : null
}

// The best match for an area name anywhere in India; near (the user's last area, say) tilts a vague name toward it.
export async function geocode(area: string, near?: LatLng): Promise<{ location: LatLng; name: string } | null> {
  const res = await post<any>('/maps/places', {
    textQuery: area,
    regionCode: 'IN',
    maxResultCount: 1,
    ...(near && { locationBias: { circle: { center: ll(near), radius: 50000 } } }),
  }, { 'X-Goog-FieldMask': 'places.location,places.displayName' })
  const p = res.places?.[0]
  return p ? { location: { lat: p.location.latitude, lng: p.location.longitude }, name: p.displayName.text } : null
}

// Python's round(): halves go to the nearest even number (90 s = 1.5 min -> 2, 150 s = 2.5 min -> 2). Math.round would give 3.
const roundEven = (x: number) => {
  const f = Math.floor(x), d = x - f
  return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 ? f + 1 : f
}

const waypoint = (p: PlannerPlace) => ({ waypoint: { location: { latLng: ll(p.location) } } })

// Minutes for each [origin][destination], driving with traffic at the departure time. undefined = no route.
// Driving only: the Python planner also asked for walking and took the faster, but walking won 0 of 75 real pairs
// (Indiranagar, Koramangala, Jayanagar, 2026-10-16), and that call was a third of a plan's Google cost.
// Google returns an array and leaves out an index when it is 0.
export async function legMinutes(origins: PlannerPlace[], dests: PlannerPlace[], departure?: string): Promise<(number | undefined)[][]> {
  const res = await post<any>('/maps/matrix', {
    origins: origins.map(waypoint),
    destinations: dests.map(waypoint),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    ...(departure && { departureTime: departure }),
  }, { 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition' })
  const secs = new Map<string, number>()
  for (const el of Array.isArray(res) ? res : [])
    if (el.condition === 'ROUTE_EXISTS' && el.duration) secs.set(`${el.originIndex ?? 0},${el.destinationIndex ?? 0}`, parseInt(el.duration))
  return origins.map((_, a) => dests.map((_, b) => {
    const s = secs.get(`${a},${b}`)
    return s === undefined ? undefined : Math.max(1, roundEven(s / 60))
  }))
}

const IST_MS = 330 * 60000

// RFC 3339 (UTC) time of the next occurrence of weekday (0 = Sunday) at startMin, IST. IST has no daylight saving.
export function nextDeparture(weekday: number, startMin: number, now = new Date()): string {
  const ist = new Date(now.getTime() + IST_MS) // read with the UTC getters: they then show IST clock fields
  const ahead = (weekday - ist.getUTCDay() + 7) % 7
  let when = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + ahead, Math.floor(startMin / 60), startMin % 60)
  if (when <= ist.getTime()) when += 7 * 86400000
  return new Date(when - IST_MS).toISOString().slice(0, 19) + 'Z'
}
