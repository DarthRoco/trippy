// Run: node packages/core/src/planner/places.check.ts   (no network: fetch is stubbed)
import assert from 'node:assert/strict'
import { cache } from './cache.ts'
cache.on = false // these checks fake different answers to the same request; the cache is checked in plan.check.ts
import { BARS, findCandidates, findPlace, geocode, legMinutes, nextDeparture, NOT_OUTDOOR, PRIMARY_BONUS, STOP_FILTERS, STOP_TYPE_TO_PLACES, toPlace } from './places.ts'
import { maps_url, sources } from './types.ts'
import type { PlannerPlace } from './types.ts'

// Every call goes to this stub; `reply` answers per relay path.
const sent: { path: string; body: any; mask?: string }[] = []
let reply: (path: string, body: any) => unknown = () => ({})
globalThis.fetch = (async (url: any, init: any) => {
  const path = new URL(String(url)).pathname, body = JSON.parse(init.body)
  sent.push({ path, body, mask: init.headers['X-Goog-FieldMask'] })
  return new Response(JSON.stringify(reply(path, body)))
}) as typeof fetch

const raw = (id: string, primary: string, rating: number, count: number, extra: object = {}) =>
  ({ id, displayName: { text: id }, location: { latitude: 1, longitude: 1 }, types: ['cafe'], primaryType: primary, rating, userRatingCount: count, ...extra })
const place = (id: string, lat = 12.97, lng = 77.64): PlannerPlace =>
  ({ place_id: id, name: id, location: { lat, lng }, open: null, attributes: {}, evidence: [] })

// Same tables as the Python adapter.
assert.deepEqual(STOP_TYPE_TO_PLACES.snack, ['bakery', 'ice_cream_shop'])
assert.deepEqual(STOP_TYPE_TO_PLACES.sunset, ['park'])
assert.equal(PRIMARY_BONUS, 1.3)
assert.ok(BARS.has('pub') && NOT_OUTDOOR.has('doctor'))
assert.deepEqual([...STOP_FILTERS.coffee![0]].sort(), ['cafe', 'coffee_shop', 'tea_house'])
assert.equal(STOP_FILTERS.walk![1], NOT_OUTDOOR)
assert.equal(STOP_FILTERS.dinner, undefined)

// toPlace: Google JSON -> planner place.
const full = toPlace({
  id: 'abc', displayName: { text: 'Third Wave' }, formattedAddress: '12 CMH Rd', location: { latitude: 12.97, longitude: 77.64 },
  types: ['cafe', 'food'], primaryType: 'coffee_shop', rating: 4.5, userRatingCount: 321, outdoorSeating: true,
  priceLevel: 'PRICE_LEVEL_MODERATE', parkingOptions: { freeParkingLot: true, paidStreetParking: false },
  regularOpeningHours: { periods: [{ open: { day: 0, hour: 10 }, close: { day: 0, hour: 22 } }] },
})
assert.deepEqual(full, { place_id: 'abc', name: 'Third Wave', location: { lat: 12.97, lng: 77.64 }, address: '12 CMH Rd', rating: 4.5, reviews: 321,
  price: 'MODERATE', types: ['cafe', 'food'], type: 'coffee_shop', open: [[600, 1320]], outdoor_seating: true, parking: true, attributes: {}, evidence: [] })
assert.equal(toPlace(raw('x', 'cafe', 4, 1, { parkingOptions: { freeParkingLot: false, paidStreetParking: false } })).parking, false)
const bare = toPlace({ id: 'y', location: { latitude: 1, longitude: 2 } }) // Google left everything out
assert.deepEqual([bare.name, bare.address, bare.types, bare.open, bare.parking, bare.outdoor_seating, bare.rating, bare.reviews], ['', '', [], null, undefined, undefined, undefined, 0])
assert.equal(toPlace(raw('z', 'cafe', 4, 1, { parkingOptions: {} })).parking, undefined) // an empty answer is no answer

// Port of test_primary_type_match_outranks_a_higher_popularity_tag_only_place.
reply = () => ({ places: [raw('burger', 'restaurant', 4.5, 20000), raw('roaster', 'coffee_shop', 4.4, 2000)] })
assert.deepEqual((await findCandidates('coffee', { lat: 1, lng: 1 })).map(p => p.place_id), ['roaster', 'burger'])
assert.equal(sent.length, 1)
assert.equal(sent[0].path, '/maps/nearby')
assert.deepEqual(sent[0].body, { includedTypes: ['cafe', 'coffee_shop'], maxResultCount: 20,
  locationRestriction: { circle: { center: { latitude: 1, longitude: 1 }, radius: 1500 } } })
const FULL_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.rating,' +
  'places.userRatingCount,places.priceLevel,places.businessStatus,places.regularOpeningHours,places.outdoorSeating,places.parkingOptions'
assert.equal(sent[0].mask, FULL_MASK)

// Closed places, bars on a coffee stop, and temples on a walk are dropped; a stop type with no filter keeps what it gets.
reply = () => ({ places: [
  raw('open', 'cafe', 4, 100), raw('closed', 'cafe', 5, 900, { businessStatus: 'CLOSED_TEMPORARILY' }),
  raw('pub', 'cafe', 5, 900, { types: ['cafe', 'pub'] }), raw('shop', 'store', 5, 900, { types: ['store'] }), raw('tea', 'tea_house', 3, 100, { types: ['tea_house'] }),
] })
assert.deepEqual((await findCandidates('coffee', { lat: 1, lng: 1 }, 800)).map(p => p.place_id), ['open', 'tea'])
assert.equal(sent.at(-1)!.body.locationRestriction.circle.radius, 800)
reply = () => ({ places: [raw('park', 'park', 4, 10, { types: ['park'] }), raw('temple', 'park', 5, 10, { types: ['park', 'hindu_temple'] })] })
assert.deepEqual((await findCandidates('walk', { lat: 1, lng: 1 })).map(p => p.place_id), ['park'])
reply = () => ({ places: [raw('a', 'restaurant', 4, 10, { types: ['store'] }), raw('b', 'restaurant', 5, 10, { types: ['store'] }), raw('c', 'restaurant', 3, 10, { types: ['store'] })] })
assert.deepEqual((await findCandidates('dinner', { lat: 1, lng: 1 }, 1500, 2)).map(p => p.place_id), ['b', 'a']) // top n by score
reply = () => ({ places: [raw('a', 'restaurant', 4, 10), raw('b', 'restaurant', 4, 10)] })
assert.deepEqual((await findCandidates('lunch', { lat: 1, lng: 1 })).map(p => p.place_id), ['a', 'b']) // ties keep Google's order
reply = () => ({}) // Google omits places when it found none
assert.deepEqual(await findCandidates('bar', { lat: 1, lng: 1 }), [])

// Shopping with the user's words: a text search inside a square around the area, same fields, Google's order kept
// (best match to the words first, not best rated); closed shops still dropped. With no words: nearby shops by type.
sent.length = 0
reply = () => ({ places: [raw('boutique', 'jewelry_store', 4.1, 40), raw('chain', 'jewelry_store', 4.8, 9000),
  raw('gone', 'jewelry_store', 5, 10, { businessStatus: 'CLOSED_PERMANENTLY' })] })
assert.deepEqual((await findCandidates('shopping', { lat: 12.97, lng: 77.64 }, 1500, 8, 'demi fine statement ring')).map(p => p.place_id), ['boutique', 'chain'])
assert.equal(sent[0].path, '/maps/places')
assert.equal(sent[0].mask, FULL_MASK)
const text: any = sent[0].body, { rectangle } = text.locationRestriction
assert.deepEqual([text.textQuery, text.maxResultCount], ['demi fine statement ring', 20])
assert.ok(Math.abs(rectangle.high.latitude - 12.97 - 1500 / 111320) < 1e-9 && Math.abs(rectangle.low.latitude - 12.97 + 1500 / 111320) < 1e-9)
assert.ok(rectangle.high.longitude - 77.64 > 1500 / 111320) // a degree of longitude is shorter than one of latitude
// Google's text search wants every word, so each alternative is its own search; answers are taken in turn, each place once.
sent.length = 0
const shops: Record<string, unknown[]> = { 'demi fine': [raw('d1', 'jewelry_store', 4, 9), raw('both', 'jewelry_store', 4, 9)],
  'semi precious statement ring': [raw('both', 'jewelry_store', 4, 9), raw('s1', 'jewelry_store', 4, 9), raw('s2', 'jewelry_store', 4, 9)], books: [raw('b1', 'book_store', 4, 9)] }
reply = (_, body) => ({ places: shops[body.textQuery] })
assert.deepEqual((await findCandidates('shopping', { lat: 1, lng: 1 }, 1500, 8, 'demi fine or semi precious statement ring, and books')).map(p => p.place_id),
  ['d1', 'both', 'b1', 's1', 's2'])
assert.deepEqual(sent.map(x => x.body.textQuery), ['demi fine', 'semi precious statement ring', 'books'])
sent.length = 0
await findCandidates('shopping', { lat: 1, lng: 1 }, 1500, 8, 'Orange decor') // "or" inside a word is not a split
assert.deepEqual(sent.map(x => x.body.textQuery), ['Orange decor'])
sent.length = 0
await findCandidates('shopping', { lat: 1, lng: 1 })
assert.deepEqual([sent[0].path, sent[0].body.includedTypes], ['/maps/nearby', STOP_TYPE_TO_PLACES.shopping])

// findPlace: the user's named place, best text match near the area, full planner fields; none found or closed for good = null.
sent.length = 0
reply = () => ({ places: [raw('kopitiam', 'malaysian_restaurant', 4.4, 3000)] })
assert.equal((await findPlace('Kopitiam Lah', { lat: 12.97, lng: 77.64 }))?.place_id, 'kopitiam')
assert.deepEqual(sent[0].body, { textQuery: 'Kopitiam Lah', maxResultCount: 1, locationBias: { circle: { center: { latitude: 12.97, longitude: 77.64 }, radius: 5000 } } })
assert.equal(sent[0].path, '/maps/places')
assert.equal(sent[0].mask, FULL_MASK)
reply = () => ({})
assert.equal(await findPlace('Nowhere Diner', { lat: 1, lng: 1 }), null)
reply = () => ({ places: [raw('shut', 'restaurant', 4, 10, { businessStatus: 'CLOSED_PERMANENTLY' })] })
assert.equal(await findPlace('Old Place', { lat: 1, lng: 1 }), null)

// Port of test_sources_start_with_google_page_and_drop_duplicates.
const p = place('abc')
p.evidence = [{ attribute: 'a', claim: 'c', url: 'https://a.com/x' }, { attribute: 'b', claim: 'c', url: 'https://a.com/x' }, { attribute: 'c', claim: 'c', url: maps_url(p) }]
assert.deepEqual(sources(p), [maps_url(p), 'https://a.com/x'])

// geocode: all of India, biased to `near` when given, null when Google finds nothing.
sent.length = 0
reply = () => ({ places: [{ location: { latitude: 28.6, longitude: 77.2 }, displayName: { text: 'Connaught Place' } }] })
assert.deepEqual(await geocode('Connaught Place'), { location: { lat: 28.6, lng: 77.2 }, name: 'Connaught Place' })
assert.equal(sent[0].path, '/maps/places')
assert.deepEqual(sent[0].body, { textQuery: 'Connaught Place', regionCode: 'IN', maxResultCount: 1 })
assert.equal(sent[0].mask, 'places.location,places.displayName')
await geocode('Indiranagar', { lat: 12.9, lng: 77.6 })
assert.deepEqual(sent[1].body.locationBias, { circle: { center: { latitude: 12.9, longitude: 77.6 }, radius: 50000 } })
reply = () => ({})
assert.equal(await geocode('zzzz nowhere'), null)
reply = () => ({ places: [] })
assert.equal(await geocode('zzzz nowhere'), null)

// legMinutes: driving with traffic only (one call); halves round to even; Google leaves out index 0 and sends an array.
sent.length = 0
const ok = 'ROUTE_EXISTS'
reply = () => [{ duration: '90s', condition: ok }, // origin 0, destination 0: both indexes left out
  { destinationIndex: 1, duration: '150s', condition: ok },
  { originIndex: 1, condition: 'ROUTE_NOT_FOUND' }]
const [a, b] = [place('a'), place('b', 12.98, 77.65)]
const dep = '2026-10-18T08:30:00Z'
assert.deepEqual(await legMinutes([a, b], [a, b], dep), [
  [2, 2], // 90 s = 1.5 min -> 2, 150 s = 2.5 min -> 2 (not 3)
  [undefined, undefined], // (1,0) not in the reply; (1,1) no route
])
const drive = sent[0]
assert.equal(sent.length, 1) // no walking call any more
assert.equal(drive.path, '/maps/matrix')
assert.equal(drive.body.travelMode, 'DRIVE')
assert.equal(drive.mask, 'originIndex,destinationIndex,duration,condition')
assert.equal(drive.body.routingPreference, 'TRAFFIC_AWARE')
assert.equal(drive.body.departureTime, dep)
assert.deepEqual(drive.body.origins[1], { waypoint: { location: { latLng: { latitude: 12.98, longitude: 77.65 } } } })
assert.equal(drive.body.destinations.length, 2)
sent.length = 0
await legMinutes([a], [b]) // no departure time: none sent
assert.equal(sent.find(s => s.body.travelMode === 'DRIVE')!.body.departureTime, undefined)
// Rounding: 0.5 -> 0 -> at least 1; 3.5 -> 4; 4.5 -> 4; 5.5 -> 6.
for (const [secs, min] of [[10, 1], [30, 1], [210, 4], [270, 4], [330, 6], [60, 1], [0, 1]]) {
  reply = () => [{ duration: secs + 's', condition: ok }]
  assert.deepEqual(await legMinutes([a], [b]), [[min]], secs + ' s')
}
reply = () => ({ error: { message: 'x' } }) // not an array: nothing reached
assert.deepEqual(await legMinutes([a], [b]), [[undefined]])

// nextDeparture: the next weekday and time in IST, as UTC. 2026-10-11 is a Sunday; 04:00Z is 09:30 IST.
const now = new Date('2026-10-11T04:00:00Z')
assert.equal(nextDeparture(0, 14 * 60, now), '2026-10-11T08:30:00Z') // later today
assert.equal(nextDeparture(0, 8 * 60, now), '2026-10-18T02:30:00Z') // already past: next week
assert.equal(nextDeparture(0, 9 * 60 + 30, now), '2026-10-18T04:00:00Z') // exactly now counts as past
assert.equal(nextDeparture(6, 14 * 60, now), '2026-10-17T08:30:00Z')
const late = new Date('2026-10-11T20:00:00Z') // 01:30 IST on Monday: IST's date is a day ahead of UTC's
assert.equal(nextDeparture(0, 60, late), '2026-10-17T19:30:00Z')
assert.equal(nextDeparture(1, 120, late), '2026-10-11T20:30:00Z') // 02:00 IST today
assert.equal(nextDeparture(1, 0, late), '2026-10-18T18:30:00Z')
assert.match(nextDeparture(3, 600), /^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/) // default: now
console.log('planner places ok')
