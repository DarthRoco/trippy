// Run: node packages/core/src/context.check.ts   (no network) - trip model v2: computed reads and the write rules.
import assert from 'node:assert/strict'
import { encode, km } from './geo.ts'
import { ahead, applyFix, arrived, buildContext, cards, forgotLine, history, newTrip, nextSteps, offRoute, onRoad, routeAhead, shown,
  upsertPlaces, withStop } from './context.ts'
import { istIso } from './time.ts'
import type { Place, Search, Trip } from './types.ts'

// Origin p1 at the start; stop p3 already reached; stop p5 at the corner; destination p2 at the end.
// Leg to p5: ~10.5 km east, 20 min. Leg to p2: ~11.1 km north, 25 min.
const at = (lat: number, lng: number, extra: Partial<Place> = {}): Place => ({ place_id: `id${lat},${lng}`, name: `${lat},${lng}`, location: { lat, lng }, ...extra })
const trip: Trip = {
  id: 't', origin: 'p1',
  plan: [{ ref: 'p3', kind: 'stop', reached_at: 'x' }, { ref: 'p5', kind: 'stop', reached_at: null }, { ref: 'p2', kind: 'destination', reached_at: null }],
  fix: { lat: 19, lng: 72.8, t: 'x' }, live: true,
  route: [
    { to: 'p5', polyline: encode([{ lat: 19, lng: 72.8 }, { lat: 19, lng: 72.9 }]), duration_sec: 1200, distance_m: 10500,
      steps: [{ text: 'east', km: 5 }, { text: 'east more', km: 5.5 }] },
    { to: 'p2', polyline: encode([{ lat: 19, lng: 72.9 }, { lat: 19.1, lng: 72.9 }]), duration_sec: 1500, distance_m: 11100,
      steps: [{ text: 'north', km: 11.1 }] },
  ],
  places: { p1: at(19, 72.8), p2: at(19.1, 72.9), p3: at(19, 72.7), p4: at(18, 72), p5: at(19, 72.9, { rating: 4.2 }) },
  searches: [], notes: [], messages: [],
}

// ahead: cumulative from the fix; the current leg by its share still ahead.
assert.deepEqual(ahead(trip).map(a => [a.ref, a.kind, a.min, a.km]), [['p5', 'stop', 20, 10.5], ['p2', 'destination', 45, 21.6]])
const mid = { ...trip, fix: { lat: 19.00045, lng: 72.85, t: 'x' } } // halfway along the first leg, 50 m off it
assert.deepEqual(ahead(mid).map(a => a.min), [10, 35])
assert.deepEqual(nextSteps(mid).map(s => [s.text, s.km]), [['east more', 5.2]]) // ~5.26 km done; first step behind
assert.equal(offRoute(mid), false)
assert.equal(offRoute({ ...trip, fix: { lat: 19.05, lng: 72.8, t: 'x' } }), true) // 5.5 km off
const road = routeAhead(mid)!
assert.ok(Math.abs(road.sec - (600 + 1500)) < 15, `sec ${road.sec}`)

// applyFix: reaching p5 (~30 m away) ticks it; the route is not touched, its leg drops out and p2's leg is current.
const atStop = applyFix(trip, { lat: 19.0003, lng: 72.9 }, true, 'T1')
assert.equal(atStop.plan[1].reached_at, 'T1')
assert.equal(atStop.route, trip.route)
assert.deepEqual(ahead(atStop).map(a => [a.ref, a.min]), [['p2', 25]])
assert.equal(applyFix(mid, { lat: 19, lng: 72.86 }, true).plan, mid.plan) // nothing reached: same plan object
assert.equal(arrived(atStop), false)
assert.equal(arrived(applyFix(atStop, { lat: 19.1, lng: 72.9 }, true)), true)

// live: a trip from a picked place ignores live GPS far from it, goes live within ~1 km; replay always moves it.
const planned = { ...trip, live: false }
assert.equal(applyFix(planned, { lat: 19.2, lng: 72.8 }, true), planned)
assert.equal(applyFix(planned, { lat: 19.005, lng: 72.8 }, true).live, true)
assert.equal(applyFix(planned, { lat: 19.2, lng: 72.8 }, false).fix.lat, 19.2)

// at: the road the fix is on, from the step it falls in (#65). Steps "east" / "east more" name no road: nothing to say.
const roads = { ...trip, route: [{ ...trip.route![0], steps: [{ text: 'Head east on Charminar Rd toward Mogdumpur Rd', km: 5 },
  { text: 'Turn left onto Inner Ring Rd/Utkoor - Mogdumpur Rd', km: 5.5 }] }, trip.route![1]] }
assert.equal(onRoad(roads), 'on Charminar Rd')
assert.equal(onRoad({ ...roads, fix: { lat: 19, lng: 72.86, t: 'x' } }), 'on Inner Ring Rd/Utkoor - Mogdumpur Rd') // past the first step
assert.equal((buildContext(roads).trip as any).at, 'on Charminar Rd')
assert.equal(onRoad(trip), null)
assert.ok(!('at' in buildContext(trip).trip))
// No destination (G2): empty plan, no route, nothing ahead, never arrives; the context says so.
const g2 = newTrip({ place_id: null, name: 'Current location', location: { lat: 19, lng: 72.8 } })
assert.deepEqual([g2.plan, g2.route, g2.live, ahead(g2), routeAhead(g2), arrived(g2)], [[], null, true, [], null, false])
assert.ok('note' in buildContext(g2).trip)
// A trip from a picked place starts at it, not live.
const started = newTrip(at(19, 72.8), at(19.1, 72.9), { polyline: trip.route![0].polyline, duration_sec: 1200, distance_m: 10500, steps: [] })
assert.deepEqual([started.live, started.plan.map(e => e.ref), started.route![0].to, km(started.fix, started.places.p1.location)], [false, ['p2'], 'p2', 0])

// Stops (#3): a live stay within ~150 m for 4+ min, away from the origin and the plan, becomes a reached stop at the stay's
// start, placed before the first unreached entry and never routed. Once per stay; a hidden app's gap counts.
const T0 = Date.parse('2026-10-18T11:52:00+05:30'), tick = (t: Trip, min: number, lat = 19.00045, lng = 72.85) =>
  applyFix(t, { lat, lng }, true, istIso(T0 + min * 60_000))
let stay = [0, 1, 2, 3, 3.9].reduce((t, m, i) => tick(t, m, 19.00045 + i * 0.0002), trip) // ~90 m of creeping, under 4 min
assert.equal(stay.plan, trip.plan)
stay = tick(stay, 4.2)
assert.deepEqual(stay.plan.map(e => [e.ref, e.reached_at]), [['p3', 'x'], ['p6', '2026-10-18T11:52:00+05:30'], ['p5', null], ['p2', null]])
assert.deepEqual([stay.places.p6.name, stay.places.p6.place_id, stay.places.p6.location], ['Stop at 11:52', null, { lat: 19.00045, lng: 72.85 }])
assert.deepEqual(ahead(stay).map(a => a.ref), ['p5', 'p2'])
assert.equal(tick(stay, 9).plan.length, 4) // still there: logged once
assert.equal(tick(tick(trip, 0), 30).plan.length, 4) // hidden 30 min, back where it was
assert.equal(tick(tick(trip, 0), 30, 19.01).plan, trip.plan) // hidden, back ~1 km on: moved
assert.equal(tick(tick(trip, 0, 19, 72.9), 10, 19, 72.9).plan.length, 3) // waiting at the planned stop p5: no new entry
assert.equal(tick(tick({ ...trip, live: false }, 0), 10).plan, trip.plan) // not live: GPS is not the car
const g2Stop = tick(tick(g2, 0, 19.1, 72.8), 5, 19.1, 72.8) // no destination: the context keeps its note and lists the stop
assert.deepEqual([g2Stop.plan.length, (buildContext(g2Stop).trip as any).reached, 'note' in buildContext(g2Stop).trip], [1, ['p2 Stop at 11:52 (stop)'], true])

// upsertPlaces: same place_id keeps its ref with the newer facts; new places get the next ref; refs are never reused.
const up = upsertPlaces(trip.places, [at(19, 72.9, { rating: 4.5 }), at(18.9, 72.8), { place_id: null, name: 'x', location: { lat: 0, lng: 0 } }])
assert.deepEqual(up.refs, ['p5', 'p6', 'p7'])
assert.equal(up.places.p5.rating, 4.5)

// withStop: before the next unreached destination, after earlier stops; with none, at the end; never twice.
const d = (ref: string, reached_at: string | null = null) => ({ ref, kind: 'destination' as const, reached_at })
const s = (ref: string, reached_at: string | null = null) => ({ ref, kind: 'stop' as const, reached_at })
assert.deepEqual(withStop([s('a'), d('b')], 'x').map(e => e.ref), ['a', 'x', 'b'])
assert.deepEqual(withStop([d('a', 'T'), d('b')], 'x').map(e => e.ref), ['a', 'x', 'b'])
assert.deepEqual(withStop([d('a', 'T')], 'x').map(e => e.ref), ['a', 'x'])
const once = [s('x'), d('b')]
assert.equal(withStop(once, 'x'), once)

// shown, cards, history: refs from every search, newest kept, each once; history carries the refs it showed.
const search = (id: string, refs: string[]): Search => ({ id, at: new Date().toISOString(), from: { lat: 19, lng: 72.8 }, asked: 'q',
  args: { need: 'q', limit_type: 'from_now', limit_min: 15 }, candidates: refs.map(ref => ({ ref, min: 4 })),
  picks: refs.map(ref => ({ ref, reason: 'r' })), say: 'ok' })
const searched: Trip = { ...trip, searches: [search('s1', ['p3', 'p4']), search('s2', ['p5', 'p3'])],
  messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'ok', search: 's2' }, { role: 'assistant', text: 'links', link: 'p5' }] }
assert.deepEqual(shown(searched), ['p4', 'p5', 'p3'])
assert.deepEqual(cards(searched, 's2').map(c => [c.ref, c.min, c.rating, c.reason]), [['p5', 4, 4.2, 'r'], ['p3', 4, undefined, 'r']])
assert.deepEqual(history(searched).map(m => m.content), ['q', 'ok Options: p5 19,72.9, p3 19,72.7', 'links Link: p5 19,72.9'])
const ctx = buildContext(searched)
assert.equal(ctx.last_search?.results[0].ref, 'p5')
assert.equal(ctx.last_search?.found_min_ago, 0)
// A deleted note (TESTSET #54): lines before its "Forgot:" line that restate it are left out; unrelated and later lines stay.
const chat: Trip = { ...trip, messages: [{ role: 'user', text: 'dad avoids spicy food, find a veg place' },
  { role: 'assistant', text: 'Noted that Dad avoids spicy food.' }, { role: 'user', text: 'mom likes tea' },
  { role: 'assistant', text: 'Here is a mild option for dad' }, forgotLine('Dad avoids spicy food'), { role: 'user', text: 'dad avoids spicy food again' }] }
assert.deepEqual(history(chat).map(m => m.content), ['(a line about a note the user deleted, left out)',
  '(a line about a note the user deleted, left out)', 'mom likes tea', 'Here is a mild option for dad', '(The user deleted a saved note. It no longer applies.)',
  'dad avoids spicy food again'])
// The price enum never reaches the model: ₹ symbols in the context (TESTSET #47).
const priced = { ...searched, places: { ...searched.places, p5: { ...searched.places.p5, price: 'MODERATE' } } }
assert.equal(buildContext(priced).last_search?.results[0].price, '₹₹')
console.log('context ok')
