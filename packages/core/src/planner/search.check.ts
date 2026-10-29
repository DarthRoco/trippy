// Run: node packages/core/src/planner/search.check.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseWeekday, periodsToIntervals } from './hours.ts'
import { at, buildItineraries, closedBlocker, explainRejection, firstShiftThatFits, suggestRelaxations } from './search.ts'
import type { Constraints, Evidence, Interval, Itinerary, Legs, PlannerPlace, Rejected, Relaxation, SearchInput, StopType } from './types.ts'

const SUN = 0
// A place open on Sunday for the given hours.
const place = (id: string, hours: [number, number][] = [[10, 22]], rating = 4.5): PlannerPlace => ({
  place_id: id, name: id, location: { lat: 12.97, lng: 77.64 }, rating, attributes: {}, evidence: [],
  open: periodsToIntervals(hours.map(([h0, h1]) => ({ open: { day: 0, hour: h0 }, close: { day: 0, hour: h1 } }))),
})
const none: Rejected = { too_far: 0, closed: 0, over_time: 0, duplicate: 0, sunset_timing: 0, closed_by: {} }
// Sunday, 30 minutes allowed between stops. legs[i][a][b] = minutes.
const run = (stop_types: StopType[], candidates: PlannerPlace[][], legs: Legs, start_min: number, duration: number, more: Partial<SearchInput> = {}) =>
  buildItineraries({ stop_types, candidates, legs, weekday: SUN, start_min, duration, max_travel: 30, ...more })

assert.equal(at(0), '00:00')
assert.equal(at(9 * 60 + 5), '09:05')
assert.equal(at(24 * 60), '24:00')

// A valid plan is found; a leg over the travel limit, or with no route, rejects the combination.
const pair = [[place('a')], [place('b')]]
const ok = run(['coffee', 'work'], pair, [[[15]]], 14 * 60, 180)
assert.equal(ok.itineraries.length, 1)
assert.equal(ok.itineraries[0].stops[1].travel_from_prev_min, 15)
assert.deepEqual(ok.itineraries[0].stops.map(s => [s.arrive, s.depart, s.closes, s.reason]), [[840, 885, 1320, ''], [900, 960, 1320, '']])
const far = run(['coffee', 'work'], pair, [[[45]]], 14 * 60, 180)
assert.deepEqual(far.itineraries, [])
assert.equal(far.rejected.too_far, 1)
assert.equal(run(['coffee', 'work'], pair, [[[undefined]]], 14 * 60, 180).rejected.too_far, 1)
assert.equal(run(['coffee', 'work'], pair, [[]], 14 * 60, 180).rejected.too_far, 1)

// A place closed during the visit rejects the combination, and a later start is offered.
const shut = run(['coffee', 'work'], [[place('a')], [place('b', [[10, 15]])]], [[[10]]], 14 * 60, 180)
assert.deepEqual(shut.itineraries, [])
assert.deepEqual(shut.rejected, { ...none, closed: 1, closed_by: { work: 1 } })
assert.ok(suggestRelaxations(shut.rejected, 30, 14 * 60).some(o => o.label.includes('later')))

// The same place is not used for two stops.
const shared = place('a')
const twice = run(['coffee', 'work'], [[shared], [shared]], [[[5]]], 14 * 60, 180)
assert.deepEqual(twice.itineraries, [])
assert.equal(twice.rejected.duplicate, 1)

// A named stay is kept when it fits and shortened, with a warning, when it does not.
const fits = run(['coffee', 'work'], pair, [[[10]]], 14 * 60, 120, { stay: { work: 90 } }).itineraries[0]
assert.equal(fits.stops[1].depart - fits.stops[1].arrive, 90)
assert.deepEqual(fits.warnings, [])
assert.equal(fits.stops[0].depart - fits.stops[0].arrive, 20) // the coffee default gave way: 120 - 10 travel - 90
const tight = run(['coffee', 'work'], pair, [[[10]]], 14 * 60, 100, { stay: { work: 90 } }).itineraries[0]
assert.ok(tight.total_minutes <= 100)
// 90 minutes left for 45 + 90: each gets two thirds, and the fraction is dropped (coffee 30, work 60)
assert.deepEqual(tight.stops.map(s => s.depart - s.arrive), [30, 60])
assert.deepEqual(tight.warnings, ['Shortened the work stay from 90 to 60 minutes to fit your time'])
// Dropped, not rounded: 100 minutes over 45 + 60 + 75 gives 25, 33.33 and 41.67.
const three = run(['coffee', 'work', 'dinner'], [[place('a')], [place('b')], [place('c')]], [[[0]], [[0]]], 14 * 60, 100).itineraries[0]
assert.deepEqual(three.stops.map(s => s.depart - s.arrive), [25, 33, 41])
// No room for 20 minutes at each stop.
assert.equal(run(['coffee', 'work'], pair, [[[25]]], 14 * 60, 60).rejected.over_time, 1)

// Stays that fill the whole duration leave room for travel.
const full = run(['dinner', 'bar'], pair, [[[15]]], 18 * 60, 240, { stay: { dinner: 120, bar: 120 } }).itineraries
assert.equal(full.length, 1)
assert.ok(full[0].total_minutes <= 240)

// A walk that runs after dark is kept, warned about and ranked lower.
const park = [[place('a', [[6, 23]])]]
const late = run(['walk'], park, [], 17 * 60 + 45, 60, { sunset_min: 18 * 60 }).itineraries[0]
const early = run(['walk'], park, [], 16 * 60, 60, { sunset_min: 18 * 60 }).itineraries[0]
assert.deepEqual(late.warnings, ['The walk at a runs after dark'])
assert.deepEqual(early.warnings, [])
assert.ok(late.score < early.score)

// The start moves so that the sunset stop is reached 30 minutes before sunset; too large a move rejects the plan.
const dusk = [[place('a', [[6, 23]])], [place('b', [[6, 23]])]]
const moved = run(['coffee', 'sunset'], dusk, [[[10]]], 16 * 60, 120, { sunset_min: 18 * 60 + 30 }).itineraries[0]
assert.deepEqual(moved.warnings, ['Start moved to 17:05 to reach the sunset spot before sunset'])
assert.equal(moved.start_min, 17 * 60 + 5)
assert.equal(moved.stops[1].arrive, 18 * 60)
assert.equal(run(['coffee', 'sunset'], dusk, [[[10]]], 12 * 60, 120, { sunset_min: 18 * 60 + 30 }).rejected.sunset_timing, 1)

// Unknown hours: the place is kept, with a warning on the stop and on the plan.
const blank = run(['coffee'], [[{ ...place('a'), open: null }]], [], 14 * 60, 60).itineraries[0]
assert.deepEqual(blank.warnings, ['Hours for a unknown; not used for timing'])
assert.deepEqual(blank.stops[0].warnings, blank.warnings)
assert.equal(blank.stops[0].closes, null)

// Relaxations follow the real reason, most common first, three at most.
assert.deepEqual(suggestRelaxations({ ...none, closed: 9 }, 30, 17 * 60).map(o => o.label), ['Start an hour earlier, at 16:00', 'Start an hour later, at 18:00'])
assert.deepEqual(suggestRelaxations(none, 30, 600), [])
assert.deepEqual(suggestRelaxations({ ...none, too_far: 2, closed: 5, over_time: 9 }, 30, 30).map(o => o.change), [
  { duration_extra: 30 }, { start_time: '00:00' }, { start_time: '01:30' },
])
assert.deepEqual(suggestRelaxations({ ...none, too_far: 4, closed: 4 }, 20, 23 * 60).map(o => o.change), [
  { max_travel_minutes: 30 }, { max_travel_minutes: 40 }, { start_time: '22:00' },
])

// A place with evidence for a must-have outranks the same place without, which outranks one where it is refuted.
const score = (attributes: Record<string, boolean>, must_haves = ['Quiet'], type: StopType = 'coffee') =>
  run([type], [[{ ...place('a'), attributes }]], [], 14 * 60, 120, { must_haves }).itineraries[0].score
assert.ok(score({ quiet: true }) > score({}) && score({}) > score({ quiet: false }))
assert.deepEqual([score({ quiet: true }), score({}), score({ quiet: false })], [5.5, 4, 3.5])
// What a stop needs by its nature counts half, and is counted once when the user also asked for it.
assert.equal(score({ 'good for working': true }, [], 'work'), 5)
assert.equal(score({ 'good for working': true }, ['good for working'], 'work'), 5.5)
// No rating, or a rating of 0, counts as 3.5.
assert.equal(run(['coffee'], [[{ ...place('a'), rating: undefined }]], [], 14 * 60, 120).itineraries[0].score, 3.5)
assert.equal(run(['coffee'], [[place('a', [[10, 22]], 0)]], [], 14 * 60, 120).itineraries[0].score, 3.5)

// Best first, three by default; equal scores keep the order they were tried in (the last stop changes fastest).
const grid = [[place('a1'), place('a2')], [place('b1'), place('b2', [[10, 22]], 4.9), place('b3')]]
const flat0 = [[[5, 5, 5], [5, 5, 5]]]
const ids = (its: Itinerary[]) => its.map(it => it.stops.map(s => s.place.place_id).join(' '))
assert.deepEqual(ids(run(['coffee', 'work'], grid, flat0, 14 * 60, 180).itineraries), ['a1 b2', 'a2 b2', 'a1 b1'])
assert.deepEqual(ids(run(['coffee', 'work'], grid, flat0, 14 * 60, 180, { top: 6 }).itineraries), ['a1 b2', 'a2 b2', 'a1 b1', 'a1 b3', 'a2 b1', 'a2 b3'])

// A shifted start: the nearest that fits wins, earlier before later; starts outside 00:00 to 22:00 are not tried.
assert.deepEqual(firstShiftThatFits(s => (s === 8 * 60 ? ['plan'] : []), 9 * 60), { found: ['plan'], start: 8 * 60 })
assert.deepEqual(firstShiftThatFits(s => (s === 7 * 60 || s === 11 * 60 ? ['plan'] : []), 9 * 60), { found: ['plan'], start: 7 * 60 })
assert.equal(firstShiftThatFits(() => [], 9 * 60), null)
const tried: number[] = []
firstShiftThatFits(s => (tried.push(s), []), 30)
assert.deepEqual(tried, [90, 150])
assert.equal(firstShiftThatFits(() => ['plan'], 21 * 60 + 30, [60]), null)

// The stop type closed most often; the first one counted wins a tie.
assert.equal(closedBlocker({ ...none, closed_by: { walk: 15, coffee: 10 } }), 'walk')
assert.equal(closedBlocker({ ...none, closed_by: { coffee: 5, walk: 5 } }), 'coffee')
assert.equal(closedBlocker(none), null)

// The explanation names the closed stop and its hours, and asks for a start time that was assumed.
const c = { assumed: ['start_time'], start_time: '09:00', max_travel_minutes: 30, duration_minutes: 120 }
const stated = { ...c, assumed: [] }
const tavarekere = place('Tavarekere Park', [[6, 10]])
assert.equal(
  explainRejection({ ...none, closed: 25, closed_by: { walk: 25 } }, ['coffee', 'walk'], [[place('a')], [tavarekere]], SUN, c),
  'Every walk option was closed when you would be there. The top-rated one, Tavarekere Park, is open 06:00 to 10:00 that day.'
    + ' You did not say when you want to go, so I assumed 09:00. Tell me when you want to go and I will use that.')
assert.equal(
  explainRejection({ ...none, closed: 1, closed_by: { walk: 1 } }, ['coffee', 'walk'], [[place('a')], [tavarekere]], 1, stated),
  'Every walk option was closed when you would be there. The top-rated one, Tavarekere Park, is open not at all that day.')
assert.equal(explainRejection({ ...none, too_far: 3 }, ['coffee'], [[]], SUN, stated), 'The places for your stops are more than 30 minutes apart.')
assert.equal(
  explainRejection({ ...none, over_time: 3 }, ['coffee'], [[]], SUN, { ...c, assumed: ['duration_minutes'] }),
  'Your stays and travel add up to more than 120 minutes. You did not say how long you have, so I assumed 120. Tell me how long you have and I will use that.')
assert.equal(
  explainRejection({ ...none, sunset_timing: 2, too_far: 2 }, ['sunset'], [[]], SUN, stated),
  'The sunset stop cannot be reached in time without moving your start by more than two and a half hours.')
assert.equal(explainRejection({ ...none, duplicate: 4 }, ['coffee'], [[]], SUN, c), 'No combination of places fit your request.')

// Same answers as the Python planner on real Google places and drive times: every search it ran for nine requests,
// each once with the real evidence and once with made-up evidence so that scoring by evidence is exercised.
type GoldPlace = {
  id: string; name: string; lat: number; lon: number; rating: number | null; rating_count: number
  open_intervals: Interval[] | null; outdoor_seating: boolean | null; parking: boolean | null; primary_type: string
  attributes: Record<string, boolean | null>; evidence: Evidence[]
}
type GoldItinerary = Omit<Itinerary, 'stops'> & {
  stops: { stop_type: StopType; place_id: string; arrive: number; depart: number; travel_from_prev_min: number; warnings: string[]; closes: number | null }[]
}
type GoldSearch = {
  input: Omit<SearchInput, 'candidates' | 'legs'> & { candidates: GoldPlace[][]; legs: [number, number, number][][] }
  itineraries: GoldItinerary[]; rejected: Rejected; relaxations: Relaxation[]
}
type Golden = { searches: GoldSearch[]; plans: { constraints: Constraints; message: string; options: Relaxation[] }[] }
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8')) as Golden

const toPlace = (p: GoldPlace): PlannerPlace => ({
  place_id: p.id, name: p.name, location: { lat: p.lat, lng: p.lon }, reviews: p.rating_count, type: p.primary_type, open: p.open_intervals,
  ...(p.rating != null && { rating: p.rating }),
  ...(p.outdoor_seating != null && { outdoor_seating: p.outdoor_seating }),
  ...(p.parking != null && { parking: p.parking }),
  attributes: Object.fromEntries(Object.entries(p.attributes).filter((e): e is [string, boolean] => e[1] != null)),
  evidence: p.evidence,
})
const toInput = ({ candidates, legs, ...rest }: GoldSearch['input']): SearchInput => ({
  ...rest,
  candidates: candidates.map(ps => ps.map(toPlace)),
  // [a, b, minutes] triples -> legs[i][a][b]; a pair that was not recorded stays undefined (no route)
  legs: legs.map((triples, i) => {
    const grid: (number | undefined)[][] = candidates[i].map(() => [])
    for (const [a, b, m] of triples) grid[a][b] = m
    return grid
  }),
})
// An itinerary in the recorded shape, without the score (compared apart, with a tolerance).
const shape = (it: Itinerary) => ({
  stops: it.stops.map(s => ({
    stop_type: s.stop_type, place_id: s.place.place_id, arrive: s.arrive, depart: s.depart,
    travel_from_prev_min: s.travel_from_prev_min, warnings: s.warnings, closes: s.closes,
  })),
  total_minutes: it.total_minutes, warnings: it.warnings, start_min: it.start_min,
})

// The recorder kept a reference to each plan's warnings list, and the Python pipeline then put its own "Moved your
// start from ..." note at the front of the plans it returned after shifting the start. That note is the pipeline's, not
// the search's (which never writes one starting like that), so it is dropped from the recorded side.
const own = (warnings: string[]) => warnings.filter(w => !w.startsWith('Moved your start from '))

assert.ok(golden.searches.length >= 28)
let matched = 0, withPlans = 0
golden.searches.forEach((g, n) => {
  const input = toInput(g.input)
  const { itineraries, rejected } = buildItineraries(input)
  const label = `search ${n} (${g.input.stop_types.join(', ')} from ${at(g.input.start_min)})`
  assert.deepEqual(itineraries.map(shape), g.itineraries.map(({ score, warnings, ...rest }) => ({ ...rest, warnings: own(warnings) })), label)
  itineraries.forEach((it, i) => assert.ok(Math.abs(it.score - g.itineraries[i].score) < 1e-9, `${label}: score ${it.score}, Python said ${g.itineraries[i].score}`))
  assert.deepEqual(rejected, g.rejected, label)
  // key order too: it decides which stop type is named when two were closed equally often
  assert.deepEqual(Object.keys(rejected.closed_by), Object.keys(g.rejected.closed_by), label)
  assert.deepEqual(suggestRelaxations(rejected, g.input.max_travel, g.input.start_min), g.relaxations, label)
  for (const s of itineraries.flatMap(it => it.stops)) assert.equal(s.reason, '')
  matched++
  if (itineraries.length) withPlans++
})
assert.equal(matched, golden.searches.length)
assert.ok(withPlans >= 10 && withPlans < matched) // both outcomes are covered

// Where the Python planner found nothing, the message it gave. The message is built from the search at the asked
// start time: the last recorded search with the request's stops, day, start, limits and must-haves (the real run).
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
let explained = 0
for (const plan of golden.plans.filter(p => p.message)) {
  const c = plan.constraints
  const g = golden.searches.findLast(({ input: i }) =>
    i.stop_types.join() === c.stops.join() && i.start_min === minutes(c.start_time) && i.weekday === parseWeekday(c.day, -1)
    && i.duration === c.duration_minutes && i.max_travel === c.max_travel_minutes && (i.must_haves ?? []).join() === c.must_haves.join())
  assert.ok(g, `no recorded search for the request in ${c.area}`)
  const input = toInput(g.input)
  const { rejected } = buildItineraries(input)
  assert.equal(explainRejection(rejected, input.stop_types, input.candidates, input.weekday, c), plan.message)
  assert.deepEqual(suggestRelaxations(rejected, c.max_travel_minutes, minutes(c.start_time)), plan.options)
  explained++
}
assert.ok(explained >= 2)

// Meals against the time of day: a dinner at 08:05 is kept but flagged, and ranks below the same dinner at 19:00.
const meal = [[place('d', [[6, 23]])]]
const breakfast = run(['dinner'], meal, [], 8 * 60 + 5, 90).itineraries[0]
const supper = run(['dinner'], meal, [], 19 * 60, 90).itineraries[0]
assert.deepEqual(breakfast.warnings, ['The dinner stop at d starts at 08:05, outside usual dinner hours (18:00 to 23:30)'])
assert.deepEqual(supper.warnings, [])
assert.ok(breakfast.score < supper.score)

// Budget: a low budget ranks an expensive place below a cheap one with the same rating; no budget, no penalty.
const priced = [[{ ...place('fancy'), price: 'EXPENSIVE' }, { ...place('cheap'), price: 'INEXPENSIVE' }]]
const firstPick = (more: Partial<SearchInput>) => run(['coffee'], priced, [], 14 * 60, 60, more).itineraries.map(it => it.stops[0].place.place_id)
assert.deepEqual(firstPick({ budget: 'low' }), ['cheap', 'fancy'])
assert.deepEqual(firstPick({ budget: 'high' }), ['fancy', 'cheap']) // equal scores keep their order
assert.deepEqual(firstPick({}), ['fancy', 'cheap'])

// "1 minute", not "1 minutes".
assert.equal(explainRejection({ ...none, too_far: 3 }, ['coffee', 'walk'], pair, SUN, { ...stated, max_travel_minutes: 1 }),
  'The places for your stops are more than 1 minute apart.')

// A set time (the user's named place at 7pm): the start is worked back from it, so the shopping stop before it ends in
// time to drive there; the stop after it follows. The start time passed in is not used.
const set = run(['shopping', 'dinner', 'bar'], [[place('shop', [[10, 22]])], [place('kopitiam', [[12, 23]])], [place('pub', [[12, 23]])]],
  [[[12]], [[8]]], 9 * 60, 240, { fixed: { stop: 1, at: 19 * 60, own: true } }).itineraries[0]
assert.deepEqual(set.stops.map(s => [s.arrive, s.depart]), [[18 * 60 + 3, 18 * 60 + 48], [19 * 60, 20 * 60 + 15], [20 * 60 + 23, 21 * 60 + 23]])
assert.equal(set.start_min, 18 * 60 + 3)
assert.deepEqual(set.warnings, [])
// The user's own place closed at its time is kept and warned about; a searched place closed at a set time is rejected.
const shutAt7 = [[place('shop')], [place('kopitiam', [[12, 15]])]]
const kept = run(['shopping', 'dinner'], shutAt7, [[[10]]], 9 * 60, 180, { fixed: { stop: 1, at: 19 * 60, own: true } })
assert.deepEqual(kept.itineraries[0].warnings, ['kopitiam may be closed during your visit, 19:00 to 20:15. Google lists it open 12:00 to 15:00 that day.'])
assert.deepEqual(kept.itineraries[0].stops[1].warnings, kept.itineraries[0].warnings)
assert.match(run(['dinner'], [[place('k', [[12, 15]])]], [], 0, 90, { fixed: { stop: 0, at: 19 * 60, own: true }, weekday: 1 }).itineraries[0].warnings[0], /closed all day/)
assert.deepEqual(run(['shopping', 'dinner'], shutAt7, [[[10]]], 9 * 60, 180, { fixed: { stop: 1, at: 19 * 60, own: false } }).rejected,
  { ...none, closed: 1, closed_by: { dinner: 1 } })
// What the user wants to buy counts like a must-have at the shopping stop only (full weight, not the half of INHERENT).
const shop = (attributes: Record<string, boolean>) =>
  run(['shopping'], [[{ ...place('s'), attributes }]], [], 14 * 60, 60, { stop_wants: [['sells statement rings']] }).itineraries[0].score
assert.deepEqual([shop({ 'sells statement rings': true }), shop({}), shop({ 'sells statement rings': false })], [5.5, 4, 3.5])
console.log('planner search ok')
