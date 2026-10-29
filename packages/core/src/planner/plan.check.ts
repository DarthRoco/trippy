// Run: node packages/core/src/planner/plan.check.ts
// The whole pipeline against a fake relay (fetch is stubbed): no network, no keys, no cost.
import assert from 'node:assert/strict'
import { cache } from './cache.ts'
cache.on = false // these checks fake different answers to the same request; the cache is checked in plan.check.ts
import { cannotPlan, plan, UnknownArea } from './plan.ts'
import type { Constraints } from './types.ts'

const SUNDAY = { day: 0 }
const place = (id: string, primaryType: string, hours: [number, number][], at: [number, number], rating = 4.5) => ({
  id, displayName: { text: id }, location: { latitude: at[0], longitude: at[1] }, types: [primaryType], primaryType, rating,
  userRatingCount: 900, businessStatus: 'OPERATIONAL',
  regularOpeningHours: { periods: hours.map(([a, b]) => ({ open: { ...SUNDAY, hour: a }, close: { ...SUNDAY, hour: b } })) },
})
// A park that shuts through the middle of the day, as Bangalore parks do.
const NEARBY: Record<string, unknown[]> = {
  cafe: [place('Roast House', 'coffee_shop', [[8, 22]], [12.97, 77.64]), place('Bean Stop', 'cafe', [[8, 22]], [12.971, 77.641], 4.0)],
  park: [place('Lake Park', 'park', [[6, 10], [16, 21]], [12.972, 77.642])],
  restaurant: [place('Noodle Bar', 'restaurant', [[12, 23]], [12.973, 77.643])],
}
// Text searches: the area, the user's named places, and shops for what they want to buy.
const TEXT: Record<string, unknown[]> = {
  'Kopitiam Lah': [place('Kopitiam Lah', 'malaysian_restaurant', [[12, 23]], [12.974, 77.644])],
  'statement ring': [place('Ring Studio', 'jewelry_store', [[11, 21]], [12.975, 77.645], 4.2), place('Gem House', 'jewelry_store', [[11, 21]], [12.976, 77.646])],
}

let areaFound = true, legSeconds = 300
const calls: { path: string; body: any }[] = []
globalThis.fetch = (async (url: string, init: { body: string }) => {
  const path = new URL(url).pathname, body = JSON.parse(init.body)
  calls.push({ path, body })
  const data = path === '/maps/places' ? (body.textQuery !== 'Testpur' ? { places: TEXT[body.textQuery] }
    : areaFound ? { places: [{ location: { latitude: 12.97, longitude: 77.64 }, displayName: { text: 'Testpur' } }] } : {})
    : path === '/maps/nearby' ? { places: NEARBY[body.includedTypes[0]] }
    : path === '/maps/matrix' ? body.origins.flatMap((_: unknown, a: number) => body.destinations.map((_: unknown, b: number) => (
      { originIndex: a, destinationIndex: b, duration: `${legSeconds}s`, condition: 'ROUTE_EXISTS' })))
    : path === '/llm' ? { choices: [{ message: { content: 'A calm spot close to the last stop.' } }] }
    : null
  assert.ok(data, `unexpected relay path ${path}`)
  return new Response(JSON.stringify(data))
}) as unknown as typeof fetch

const c: Constraints = { duration_minutes: 120, start_time: '14:00', day: 'Sunday', area: 'Testpur', stops: ['coffee', 'walk'],
  max_travel_minutes: 30, budget: 'medium', stay_minutes: {}, assumed: ['start_time'], must_haves: [] }
const now = new Date('2026-10-11T04:00:00Z') // Sunday 09:30 IST
const steps: string[] = []

// The park is closed at 14:00 and until 16:00, so the plan moves to the nearest start that works and says why.
const r = await plan(c, { web: false, now, onStep: s => steps.push(s) })
assert.equal(r.area_name, 'Testpur')
assert.equal(r.message, '')
assert.equal(r.itineraries.length, 2) // two cafes x one park
const best = r.itineraries[0]
assert.deepEqual(best.stops.map(s => s.place.name), ['Roast House', 'Lake Park']) // the better-rated cafe first
assert.equal(best.start_min, 16 * 60)
assert.deepEqual(best.stops.map(s => [s.arrive, s.depart, s.travel_from_prev_min]), [[960, 1005, 0], [1010, 1055, 5]])
assert.equal(best.warnings[0], 'Moved your start from 14:00 to 16:00 because every walk option was closed at 14:00. ' +
  'You did not give a start time, so tell me when you want to go to choose your own.')
assert.ok(best.stops.every(s => s.reason === 'A calm spot close to the last stop.'))
assert.equal(best.stops[1].closes, 21 * 60)
assert.ok(steps.includes('Finding places') && steps.includes('Writing the reasons'))
// web: false never searches the web; the drive leg asks for traffic at the planned time, in UTC.
assert.ok(!calls.some(x => x.path.startsWith('/search')))
const drive = calls.find(x => x.path === '/maps/matrix' && x.body.travelMode === 'DRIVE')!.body
assert.equal(drive.routingPreference, 'TRAFFIC_AWARE')
assert.equal(drive.departureTime, '2026-10-11T08:30:00Z') // today 14:00 IST

// Stops further apart than the limit: no plan, the real reason, and options that fix it.
legSeconds = 600
const far = await plan({ ...c, max_travel_minutes: 5, assumed: [] }, { web: false, now })
assert.deepEqual(far.itineraries, [])
assert.equal(far.message, 'The places for your stops are more than 5 minutes apart.')
assert.deepEqual(far.options.map(o => o.label), ['Allow 15 minutes between stops', 'Allow 25 minutes between stops'])
assert.equal(far.rejected?.too_far, 2)

// A stop type with no places nearby.
const saved = NEARBY.park
NEARBY.park = []
const none = await plan(c, { web: false, now })
assert.equal(none.message, 'No places found near Testpur for: walk.')
NEARBY.park = saved

// An area Google cannot find.
areaFound = false
await assert.rejects(plan(c, { web: false, now }), (e: unknown) => e instanceof UnknownArea && /Testpur/.test((e as Error).message))

// The session cache: the first plan pays the relay; a replan with a looser travel limit (a "nothing fits" fix) and a
// repeat of the same plan send nothing new, because only the search, which is code, changes.
cache.on = true
areaFound = true
legSeconds = 300
calls.length = 0
const fresh = await plan(c, { web: false, now })
const paid = calls.length
assert.ok(paid >= 5, `the first plan calls the relay (${paid})`)
const relaxed = await plan({ ...c, max_travel_minutes: 45 }, { web: false, now })
const again = await plan(c, { web: false, now })
assert.equal(calls.length, paid) // nothing new sent
assert.deepEqual(again.itineraries.map(it => it.stops.map(s => s.place.place_id)), fresh.itineraries.map(it => it.stops.map(s => s.place.place_id)))
assert.equal(relaxed.itineraries.length, fresh.itineraries.length)

// Shruti's request, planned: a ring shop found by her words, then dinner at the place she named at the time she gave.
// The start is worked back from 19:00 (not 19:00, not the assumed 16:00); the movie she also asked for is said, not planned.
cache.on = false
calls.length = 0
const ring: Constraints = { ...c, stops: ['shopping', 'dinner'], start_time: '16:00', duration_minutes: 180, assumed: ['start_time', 'duration_minutes'],
  shop_for: 'statement ring', named_places: [{ name: 'Kopitiam Lah', stop: 'dinner', time: '19:00' }], unsupported: ['movie'] }
const kop = await plan(ring, { web: false, now })
assert.equal(kop.itineraries.length, 2) // two shops, one dinner place: the options differ only in the shop
for (const it of kop.itineraries) {
  assert.deepEqual(it.stops.map(s => [s.stop_type, s.arrive, !!s.own]), [['shopping', 19 * 60 - 5 - 45, false], ['dinner', 19 * 60, true]])
  assert.equal(it.stops[1].place.name, 'Kopitiam Lah')
  assert.equal(it.stops[1].reason, '') // her own pick needs no reason
  assert.equal(it.start_min, 19 * 60 - 50)
  assert.deepEqual(it.warnings, ["I can't plan movie yet, so I planned the rest."])
}
assert.deepEqual(kop.itineraries.map(it => it.stops[0].place.name), ['Gem House', 'Ring Studio']) // better rated first
assert.deepEqual(calls.filter(x => x.path === '/maps/places').map(x => x.body.textQuery), ['Testpur', 'Kopitiam Lah', 'statement ring'])
assert.ok(!calls.some(x => x.path === '/maps/nearby')) // the dinner place is not searched for
assert.equal(calls.filter(x => x.path === '/llm').length, 2) // a reason for each shop, none for Kopitiam Lah
assert.equal(calls.find(x => x.path === '/maps/matrix')!.body.departureTime, '2026-10-11T13:30:00Z') // traffic at 19:00 IST
assert.equal(cannotPlan(['a movie', 'bowling', 'a spa']), "I can't plan a movie, bowling or a spa yet, so I planned the rest.")
assert.equal(cannotPlan(['a movie'], 'will plan'), "I can't plan a movie yet, so I will plan the rest.")

// A start she gave that the set time moves: said either way (no room before it, or time to spare).
const early = await plan({ ...ring, start_time: '18:30', assumed: [], unsupported: [] }, { web: false, now, reasons: false })
assert.deepEqual(early.itineraries[0].warnings, ['The stops before Kopitiam Lah do not fit between 18:30 and 19:00, so this plan starts at 18:10.'])
const later = await plan({ ...ring, start_time: '15:00', assumed: [], unsupported: [] }, { web: false, now, reasons: false })
assert.deepEqual(later.itineraries[0].warnings, ['Start moved to 18:10 to reach Kopitiam Lah at 19:00.'])
// The parser copied the dinner time into start_time: that is not a start, so nothing is said.
assert.deepEqual((await plan({ ...ring, start_time: '19:00', assumed: [], unsupported: [] }, { web: false, now, reasons: false })).itineraries[0].warnings, [])

// Her place shut at that time: still her plan, with a warning. A name Google cannot find: said, and other dinner
// places are searched for, still at 19:00. A named place whose stop she took off the list is not used.
TEXT['Kopitiam Lah'] = [place('Kopitiam Lah', 'malaysian_restaurant', [[12, 15]], [12.974, 77.644])]
const shut = await plan({ ...ring, unsupported: [] }, { web: false, now, reasons: false })
assert.equal(shut.itineraries[0].stops[1].place.name, 'Kopitiam Lah')
assert.deepEqual(shut.itineraries[0].warnings, ['Kopitiam Lah may be closed during your visit, 19:00 to 20:15. Google lists it open 12:00 to 15:00 that day.'])
const lost = await plan({ ...ring, unsupported: [], named_places: [{ name: 'Nowhere Diner', stop: 'dinner', time: '19:00' }] }, { web: false, now, reasons: false })
assert.equal(lost.itineraries[0].warnings[0], "I couldn't find Nowhere Diner near Testpur, so I picked other dinner places.")
assert.deepEqual(lost.itineraries[0].stops.map(s => [s.place.name, s.arrive, !!s.own]), [['Gem House', 19 * 60 - 50, false], ['Noodle Bar', 19 * 60, false]])
const dropped = await plan({ ...ring, stops: ['shopping'], unsupported: [] }, { web: false, now, reasons: false })
assert.equal(dropped.itineraries[0].start_min, 16 * 60) // no set time any more: the start is the start
// Nothing fits, with a set time: the message keeps the notes, and no "start earlier" fix is offered (the start is not used).
// A set time and an assumed length: the length is what the stops need, so 90 assumed minutes do not cut her dinner.
const roomy = await plan({ ...ring, duration_minutes: 90, unsupported: [] }, { web: false, now, reasons: false })
assert.deepEqual(roomy.itineraries[0].stops.map(s => s.depart - s.arrive), [45, 75])
assert.deepEqual((await plan({ ...ring, duration_minutes: 90, assumed: [], unsupported: [] }, { web: false, now, reasons: false }))
  .itineraries[0].stops.map(s => s.depart - s.arrive), [31, 53]) // a length she gave is kept: the stays shrink to fit
const none2 = await plan({ ...ring, max_travel_minutes: 1, assumed: [] }, { web: false, now, reasons: false })
assert.match(none2.message, /^I can't plan movie yet, so I planned the rest\. The places for your stops are more than 1 minute apart\.$/)
assert.ok(none2.options.every(o => !o.change.start_time))
console.log('planner plan ok')
