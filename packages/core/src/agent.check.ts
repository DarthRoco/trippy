// Run: node packages/core/src/agent.check.ts   (no network)
import assert from 'node:assert/strict'
import { ABSENT, ask, deadlineText, dropPromise, staleMinutes, fromDest, isPlanning, isVehicleFire, LASTING, leakedCall, META, nameClash, ON_RIDE, plain, planText, PROMISE, rank, RAW_VALUE, refWarning,
  REF } from './agent.ts'
import { encode } from './geo.ts'
import { history, newTrip, searchView } from './context.ts'
import { behind, findStops } from './find_stops.ts'
import { deadlineNote, istIso } from './time.ts'
import type { Note, Trip } from './types.ts'

const call = (args: object, name = 'find_stops') => ({ id: 'x', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })

// Urgent searches stay on the fast tier; sights and named places off the urgent path escalate.
assert.equal(isPlanning(call({ need: 'pizza', similar_to: "Domino's", limit_type: 'from_now', limit_min: 20 })), false)
assert.equal(isPlanning(call({ need: 'museum', limit_type: 'near_destination', limit_min: 15 })), true)
assert.equal(isPlanning(call({ need: 'house', places: ['Mannat'], limit_type: 'detour', limit_min: 15 })), true)
assert.equal(isPlanning(call({ need: 'ATM', limit_type: 'detour', limit_min: 5 })), false)
assert.equal(isPlanning(call({ need: 'pizza', similar_to: "Domino's", limit_type: 'detour', limit_min: 10 })), false)
assert.equal(isPlanning(call({ ref: 'p1' }, 'place_details')), false)

// A tool call written as text is recovered; prose and unknown tools are not.
const leaked = leakedCall('[{"name": "find_stops", "parameters": {"need": "mill museum", "limit_type": "near_destination", "limit_min": 15}}]')
assert.equal(leaked[0]?.function.name, 'find_stops')
assert.equal(JSON.parse(leaked[0].function.arguments).need, 'mill museum')
assert.equal(leakedCall('\n{"name": "reply", "arguments": {"text": "hi"}}')[0]?.function.name, 'reply')
// Two calls written back to back (seen with Ultra): take the first complete one.
const two = leakedCall('[{"name": "find_stops", "parameters": {"need": "mill", "limit_type": "near_destination", "limit_min": 30}}]\n[{"name": "reply", "parameters": {"text": "ok"}}]')
assert.equal(two[0]?.function.name, 'find_stops')
assert.deepEqual(leakedCall('Here are three places nearby.'), [])
assert.deepEqual(leakedCall('{"name": "delete_everything", "parameters": {}}'), [])
// Promises without action go back once; real answers do not.
assert.ok(PROMISE.test('More info coming...'))
assert.ok(PROMISE.test("I'll look up the well-known 26/11 attack sites for you."))
assert.ok(PROMISE.test('Open the doors and step away. I’ll find one fast.')) // curly apostrophe (TESTSET #50)
assert.ok(!PROMISE.test('Si Nonna\'s is open till 11 PM, about 8 minutes away.'))
assert.ok(!PROMISE.test('Let\'s stop at the Taj, 13 min from the gallery.'))
assert.ok(!PROMISE.test('Pull over safely. Let me know if you need a mechanic.'))
// Raw values (TESTSET #47): price enums become ₹ by code; field names and ": true" are caught; ordinary words stay.
assert.equal(plain('3.5★, MODERATE, open now. PRICE_LEVEL_EXPENSIVE, INEXPENSIVE, VERY_EXPENSIVE, FREE'), '3.5★, ₹₹, open now. ₹₹₹, ₹, ₹₹₹₹, free')
assert.equal(plain('Moderate prices, free parking, expensive but true to its roots'), 'Moderate prices, free parking, expensive but true to its roots')
for (const s of ['serves_veg is yes', 'open_now: true', 'price = false', 'rating null', 'min_from_here 4']) assert.ok(RAW_VALUE.test(s), s)
for (const s of ['Open now, 4.3★, true to its roots', "Let's go: it's close", 'Pure veg, 8 min away']) assert.ok(!RAW_VALUE.test(s), s)
// similar_to written as "none" and friends means absent; a real brand does not.
for (const s of ['none', 'None', 'null', 'n/a', 'N/A', '-', '--', '', '  ']) assert.ok(ABSENT.test(s), JSON.stringify(s))
for (const s of ["Domino's", 'Nonna', 'nandos']) assert.ok(!ABSENT.test(s), s)
// find_stops save keeps diet / health / mobility facts only.
for (const s of ['Dad is vegetarian', 'Mom is allergic to seafood', 'Grandma uses a wheelchair', 'We are Jain']) assert.ok(LASTING.test(s), s)
for (const s of ["User's nana worked in cotton mills, interested in Mumbai textile mill history",
  'Interested in 26/11 attack history sites near destination', 'wife wants to see Mannat']) assert.ok(!LASTING.test(s), s)
// Refs copied from history are cut from replies; ordinary words and numbers stay.
assert.equal('Back to pizza: p3 Si Nonna\'s, p4 Pizza Hut (p5), top 3'.replace(REF, ''), "Back to pizza: Si Nonna's, Pizza Hut , top 3")

// A card of a search measured from the destination answers from the search (#49); the plan leads steps / searches (#52).
const spot = (name: string) => ({ place_id: name, name, location: { lat: 19, lng: 72.8 } })
const t0 = newTrip(spot('Home'), { ...spot('Gallery'), location: { lat: 19.1, lng: 72.9 } },
  { polyline: encode([{ lat: 19, lng: 72.8 }, { lat: 19.1, lng: 72.9 }]), duration_sec: 1800, distance_m: 15000, steps: [] })
const t1: Trip = { ...t0, places: { ...t0.places, p3: spot('Taj') }, searches: [{ id: 's1', at: istIso(), from: t0.fix, asked: 'q',
  args: { need: 'sights', limit_type: 'near_destination', limit_min: 15 }, candidates: [{ ref: 'p3', min: 4, from_dest: true }],
  picks: [{ ref: 'p3', reason: '' }], say: '' }] }
assert.match(fromDest(t1, 'p3')!, /^Taj: 4 min from the destination/)
assert.equal(fromDest(t1, 'p2'), null) // not a card of the search
assert.equal(fromDest({ ...t1, searches: [{ ...t1.searches[0], candidates: [{ ref: 'p3', min: 4 }] }] }, 'p3'), null) // measured from the car
assert.match(planText(t1), /^The plan: Gallery \(destination, 30 min\)\./)

// Vehicle smoke / fire gets the code's safety text (#50); a person's emergency or a fire elsewhere does not. Who is on this
// ride is a trip note (#51); a lasting fact is not. Talk about the prompt is caught (B16).
for (const s of ['car is smoking from the bonnet', 'engine me aag, fire!', 'gaadi se dhuan nikal raha hai, smoke']) assert.ok(isVehicleFire(s), s)
for (const s of ['Accident, dad is hurt', 'there is a fire at the restaurant', 'Car is making a noise']) assert.ok(!isVehicleFire(s), s)
for (const s of ['we have a toddler with us', 'grandma is with us today', 'travelling with two kids']) assert.ok(ON_RIDE.test(s), s)
for (const s of ['Dad is vegetarian', 'Mom is allergic to seafood']) assert.ok(!ON_RIDE.test(s), s)
assert.ok(META.test('Based on Google traffic forecast - no extra claim added'))
assert.ok(!META.test('Based on Google traffic forecast, about 40 minutes'))
// Two places matching the same 2+ words the user wrote, one of them chosen: a clash (#56); single words and unique names are not.
const named = (...ns: string[]): Trip => ({ ...t0, places: Object.fromEntries(ns.map((n, i) => [`p${i + 1}`, spot(n)])) })
const haji = named('Haji Ali Dargah', 'Haji Ali Juice Centre', 'Kurla West', 'Domino\'s Pizza')
assert.deepEqual(nameClash(haji, 'tell me more about haji ali', 'p2'), ['Haji Ali Dargah', 'Haji Ali Juice Centre'])
assert.equal(nameClash(haji, 'tell me more about haji ali dargah', 'p2'), null) // dargah is said: p1 wins alone
assert.equal(nameClash(haji, 'tell me more about haji', 'p2'), null) // one word only
assert.equal(nameClash(haji, 'tell me more about haji ali', 'p4'), null) // the model chose another place
assert.equal(nameClash(named('Domino\'s Pizza', 'Domino\'s Pizza'), "domino's pizza", 'p1'), null) // same name twice
// #60: a name the user wrote that no place of the trip has, on a ref that does not carry it, is warned about. A card pointed at
// by pronoun / ordinal / #N, a ref whose own name was said, and plain content words ("parking", "muslims") are not.
assert.match(refWarning(t1, 'is Leopold open now?', 'p3')!, /^Not run: p3 is Taj, not what the user named \("leopold" /)
assert.ok(refWarning(t1, 'send Leopold to the family', 'p2'))
for (const [s, ref] of [['is the taj open now?', 'p3'], ['tell me more about the second one', 'p3'], ['is it open for non muslims?', 'p3'],
  ['Does #3 have parking?', 'p3'], ['how far is the gallery from here', 'p2'], ['send it to the family', 'p3'], ['kya taj khula hai', 'p3'],
  ['how long till we reach?', 'p2'], ['Tell me about the Taj, is it open now', 'p3']]) assert.equal(refWarning(t1, s, ref), null, s)
assert.ok(refWarning(t1, 'leopold khula hai kya', 'p3')) // typed in lowercase: any word outside the common list
assert.equal(refWarning(t1, 'is Leopold open now?', 'p2', false), null) // the model said "destination": only a clash counts
// A name clash keeps its own text; once per ref is the caller's job.
assert.match(refWarning(haji, 'tell me more about haji ali', 'p2')!, /more than one place matches/)
// A name that is in some place of the trip is not "a place not in the trip" (the word must be in no place): left alone.
assert.equal(refWarning(haji, 'is juice open now', 'p1'), null)
// A name with no Latin letter is filler only (#46): out when 4+ others fit, in when they don't.
const hit = (name: string, rating: number) => ({ ...spot(name), rating, reviews: 300, open_now: true, legsSec: [300] })
const hindi = hit('अशोक चाय वाला', 4.9), latin = ['A Chai', 'B Chai', 'C Chai', 'D Chai'].map(n => hit(n, 4.2))
const from = { fix: { lat: 19, lng: 72.8 }, ahead: null }, want = { need: 'chai', limit_type: 'from_now' as const, limit_min: 15 }
const search = (hits: any[]) => findStops({ searchNear: async () => hits } as any, from, want)
assert.deepEqual((await search([hindi, ...latin])).map(c => c.name), ['A Chai', 'B Chai', 'C Chai', 'D Chai'])
assert.ok((await search([hindi, ...latin.slice(0, 2)])).some(c => c.name === hindi.name))

// Whole turns with a scripted /llm and a counting provider (no network). Each script entry is one model round.
const tc = (name: string, args: object) => ({ id: name + Math.random(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })
async function turn(script: ReturnType<typeof tc>[][], trip: Trip, text: string, profile: Note[] = []) {
  // seen: provider calls, where the last eta started, and the tool results the model was shown (last request's messages).
  const queue = [...script], seen = { details: 0, eta: 0, etaFrom: null as any, tools: [] as string[], near: [] as string[], sys: null as any }
  const real = globalThis.fetch
  globalThis.fetch = (async (_: unknown, init: any) => {
    seen.sys ??= JSON.parse(init.body).messages.slice(1).filter((m: any) => m.role === 'system').map((m: any) => m.content)
    seen.tools = JSON.parse(init.body).messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: queue.shift() ?? [tc('reply', { text: 'out of script' })] } }] })
  }) as typeof fetch
  // An airport hotel nearer the destination than the airport: the airport must still win (Google type).
  const p = { details: async () => (seen.details++, { phone: '1' }), searchNear: async (q: string) => (seen.near.push(q), [
      { ...spot('Airport Hotel'), location: { lat: 19.1, lng: 72.9 }, type: 'hotel', legsSec: [1500] },
      { ...spot('Test International Airport'), location: { lat: 19.2, lng: 73.0 }, type: 'international_airport', legsSec: [3600] }]),
    eta: async (from: any) => (seen.eta++, seen.etaFrom = from, { durationSec: 600, distanceM: 5000 }) } as any
  try { return { ...await ask(p, trip, text, () => {}, profile), seen } } finally { globalThis.fetch = real }
}
// #64: the same tool with the same args, in one round and across rounds, runs once; a different ref still runs.
const rep = await turn([[tc('place_details', { ref: 'p3' }), tc('place_details', { ref: 'p3' })], [tc('place_details', { ref: 'p3' })],
  [tc('place_details', { ref: 'p2' })], [tc('reply', { text: 'done' })]], t1, 'tell me more about the taj')
assert.deepEqual([rep.seen.details, rep.steps.map(s => s.name + ':' + s.args.ref), rep.skipped!.length, rep.text],
  [2, ['place_details:p3', 'place_details:p2', 'reply:undefined'], 2, 'done'])

// #60 end to end: the first place_details on the wrong ref is held back (no provider call), the same call again goes through.
const wrong = await turn([[tc('place_details', { ref: 'p3' })], [tc('place_details', { ref: 'p3' })], [tc('reply', { text: 'ok' })]], t1, 'is Leopold open now?')
assert.deepEqual([wrong.seen.details, wrong.steps.length, wrong.skipped!.length], [1, 2, 1]) // place_details + reply ran; the first call was held

// #63: the destination, leaving now, is answered from the trip's own numbers (no Routes call): what the trip bar shows.
const bar = await turn([[tc('eta_from_here', { ref: 'destination' })], [tc('reply', { text: 'x' })]], t1, 'how long till we reach?')
assert.match(bar.seen.tools[0], /^Gallery: 30 min, 15 km, leaving now/)
assert.equal(bar.seen.eta, 0)
// A depart_at still asks Google (a forecast); #61: from 'destination' asks Google from the gallery, not from the car.
const later = await turn([[tc('eta_from_here', { ref: 'destination', depart_at: istIso(Date.now() + 3_600_000) })], [tc('reply', { text: 'x' })]], t1, 'ok')
assert.equal(later.seen.eta, 1)
const fromGallery = await turn([[tc('eta_from_here', { ref: 'p3', from: 'destination' })], [tc('reply', { text: 'x' })]], t1, 'how far is the taj from the gallery')
assert.deepEqual([fromGallery.seen.eta, fromGallery.seen.etaFrom], [1, t1.places.p2.location])
assert.match(fromGallery.seen.tools[0], /^Taj: 10 min, 5.0 km, from Gallery \(the destination\), not from the car/)
// A card (not in the plan) still asks Google from the car and carries the search's labelled minutes.
const card = await turn([[tc('eta_from_here', { ref: 'p3' })], [tc('reply', { text: 'x' })]], t1, 'how far is the taj')
assert.deepEqual([card.seen.eta, card.seen.etaFrom], [1, t1.fix])
assert.match(card.seen.tools[0], /^Taj: 4 min from the destination .*\nFrom the car: Taj: 10 min/)

// #62: a deadline is compared in code and handed to the model before the first round (a reply-only guard lost it to a search on the
// ride replay); an eta_from_here whose depart_at is the flight time is answered "leaving now" (no Routes call).
const noon = Date.parse('2026-10-10T17:56:00+05:30')
assert.match(deadlineText(t1, [Date.parse('2026-10-11T06:00:00+05:30')], noon)!,
  /^Gallery is 30 min ahead\. deadline 6:00 am tomorrow, arrival about 6:26 pm today: 11 h 34 min to spare\.$/i)
assert.match(deadlineText(t1, [Date.parse('2026-10-10T18:00:00+05:30'), Date.parse('2026-10-11T06:00:00+05:30')], noon)!, /arrives 26 min late OR .*ask which/)
assert.equal(deadlineText(t1, [], noon), null)
const said = await turn([[tc('reply', { text: 'Yes.' })]], t1, 'we have to reach by 6 am, will we make it?')
assert.match(said.seen.sys[0], /^The user named a deadline.*Gallery is 30 min ahead\. deadline \d+:\d\d (am|pm)/i)
assert.deepEqual([said.text, said.seen.near, said.memory.add.map(n => [/^Deadline: arrive \S+ 06:00 IST$/.test(n.text), n.scope])], ['Yes.', [], [[true, 'trip']]])
// Ride 2026-10-18 (10): a flight is measured to the airport (Google's type, not the nearer airport hotel) from the car, 90 min before;
// the eta_from_here's depart_at (the flight time) is dropped: leaving now, no Routes call. A reply not naming the airport gets it added.
const flight = await turn([[tc('eta_from_here', { ref: 'destination', depart_at: '2026-10-11T06:00:00+05:30' })], [tc('reply', { text: 'You will miss it.' })]], t1, 'our flight is at 6 am, will we make it?')
assert.deepEqual([flight.seen.eta, /^Gallery: 30 min, 15 km, leaving now/.test(flight.seen.tools[0]), flight.seen.near, flight.text],
  [0, true, ['airport'], 'You will miss it. (Measured to Test International Airport.)'])
assert.match(flight.seen.sys[0], /Measured to Test International Airport \(assumed: the airport nearest Gallery; .*\), not to the trip's destination: 60 min from the car .*flight 6:00 am \w+, so be there by 4:30 am \w+ \(90 min before\), arrival about /)
// "4pm from navi mumbai" right after a flight question: the flight's deadline at the airport named; the older flight note is replaced.
const asked = { ...t1, notes: [{ id: 'n9', text: 'Deadline: flight 2026-10-18 15:00 IST' }],
  messages: [{ role: 'user' as const, text: 'Will we still make it for the flight' }, { role: 'assistant' as const, text: 'Please give your flight time.' }] }
const nm = await turn([[tc('reply', { text: 'Test International Airport: you miss it.' })]], asked, '4pm from navi mumbai')
assert.deepEqual([nm.seen.near, nm.memory.remove, nm.memory.add.map(n => /^Deadline: flight \S+ 16:00 IST from navi mumbai$/.test(n.text)), nm.text],
  [['navi mumbai airport'], ['n9'], [true], 'Test International Airport: you miss it.'])
assert.match(nm.seen.sys[0], /Measured to Test International Airport, not to the trip's destination: 60 min/)
// A search for that airport is held once (its cards ended the turn without the verdict on the ride replay).
const hunt = await turn([[tc('find_stops', { need: 'airport', limit_type: 'from_now', limit_min: 60 })], [tc('reply', { text: 'Test International Airport: late.' })]], asked, '4pm from navi mumbai')
assert.deepEqual([hunt.seen.tools[0].startsWith('Not run: the app already measured the deadline to Test International Airport'), hunt.seen.near.length, hunt.text],
  [true, 1, 'Test International Airport: late.'])
// A later "will we still make it" reads the saved note (the 3 pm flight said at 11:22 was out of the last 10 messages at 13:15).
const later2 = await turn([[tc('reply', { text: 'ok' })]],
  { ...t1, notes: [{ id: 'n9', text: deadlineNote({ times: [Date.now() + 5 * 3_600_000], what: 'flight', hub: 'airport', buffer: 90 }) }] }, 'Will we still make it for the flight')
assert.deepEqual([later2.seen.near, later2.memory.add, /Measured to Test International Airport/.test(later2.seen.sys[0])], [['airport'], [], true])

// Ride 2026-10-18 (6): notes are for the trip; the profile only when the user's words ask for every trip, never for who is on board.
const scope = async (text: string, note: string) => (await turn([[tc('remember', { note, scope: 'profile' })], [tc('reply', { text: 'ok' })]], t1, text)).memory.add[0].scope
assert.deepEqual([await scope('Remember that dad is diabetic', 'Dad is diabetic'), await scope('always remember dad is diabetic', 'Dad is diabetic'),
  await scope('remember for next time: mom is allergic to nuts', 'Mom is allergic to nuts'), await scope('remember for every trip, grandma is with us', 'Grandma is with us')],
  ['trip', 'profile', 'profile', 'trip'])
// The user's "always" wins even when the model asks for the trip (demo recording 2026-10-30).
const asTrip = async (text: string, note: string) => (await turn([[tc('remember', { note, scope: 'trip' })], [tc('reply', { text: 'ok' })]], t1, text)).memory.add[0].scope
assert.deepEqual([await asTrip('Always remember that dad is diabetic', 'Dad is diabetic'), await asTrip('Remember that dad is diabetic', 'Dad is diabetic')],
  ['profile', 'trip'])

// Ride 2026-10-18 (5): a 28 min old search's minutes are not shown as current: left out of the context and history, a reply quoting
// them goes back once, then carries their age. A search from the destination, a fresh one, or an eta_from_here this turn is fine.
const ago = (min: number) => istIso(Date.now() - min * 60_000)
const old: Trip = { ...t1, places: { ...t1.places, p3: spot('Shiv Vadapav Centre'), p4: spot("McDonald's") },
  searches: [{ ...t1.searches[0], at: ago(28), args: { need: 'bite', limit_type: 'from_now', limit_min: 15 },
    candidates: [{ ref: 'p3', min: 2 }, { ref: 'p4', min: 12 }], picks: [{ ref: 'p3', reason: '' }] }],
  messages: [{ role: 'assistant', text: 'Shiv Vadapav Centre is 2 min away', search: 's1' }] }
assert.deepEqual([searchView(old, old.searches[0]).results[0].min, searchView(t1, t1.searches[0]).results[0].min], [undefined, 4])
assert.match(history(old)[0].content!, /Options \(minutes in this line are from 28 min ago, not from here\): p3/)
const quoted = 'Try Shiv Vadapav Centre (2 min) or McDonald’s (12 min).'
assert.deepEqual(staleMinutes(old, quoted, new Set()).map(o => [o.name, o.ago]), [['Shiv Vadapav Centre', 28], ["McDonald's", 28]])
assert.deepEqual(staleMinutes(old, quoted, new Set(['p3', 'p4'])), [])
assert.deepEqual(staleMinutes(old, 'Shiv Vadapav Centre has restrooms', new Set()), [])
assert.deepEqual(staleMinutes({ ...old, searches: [{ ...old.searches[0], at: ago(3) }] }, quoted, new Set()), [])
const twice = await turn([[tc('reply', { text: 'Shiv Vadapav Centre (2 min).' })], [tc('reply', { text: 'Shiv Vadapav Centre (2 min).' })]], old, 'washrooms?')
assert.match(twice.seen.tools[0], /^Not sent: the minutes for Shiv Vadapav Centre are from an earlier search/)
assert.equal(twice.text, 'Shiv Vadapav Centre (2 min). (Shiv Vadapav Centre: minutes from a search 28 min ago, not from here.)')
const measured = await turn([[tc('eta_from_here', { ref: 'p3' })], [tc('reply', { text: 'Shiv Vadapav Centre is 10 min away.' })]], old, 'how far is shiv vadapav')
assert.equal(measured.text, 'Shiv Vadapav Centre is 10 min away.')

// E: the forced last reply loses only its promise; a reply that is nothing but a promise still gives up honestly.
assert.equal(dropPromise('Route ahead: Thane. No public toilets show up within 15 min. Shiv Vadapav Centre is 2 min per the earlier search; let me get live ETA.'),
  'Route ahead: Thane. No public toilets show up within 15 min. Shiv Vadapav Centre is 2 min per the earlier search.')
assert.equal(dropPromise('Line one\nline two'), 'Line one\nline two') // no promise: untouched
assert.deepEqual([dropPromise('Let me check that.'), dropPromise('One moment. I will see.')], ['', 'I will see.'])
const promised = await turn([[tc('get_trip_state', { section: 'steps' })], [tc('get_trip_state', { section: 'searches' })], [tc('get_trip_state', { section: 'older_messages' })],
  [tc('reply', { text: 'The road ahead is clear for 20 km. Let me check toilets.' })]], t1, 'check ahead of me')
assert.equal(promised.text, 'The road ahead is clear for 20 km.')

// rank (#59, #67): history the data does not hold is blanked, "general" only where the name says it, an emergency lists the
// nearest first. A scripted ranker answer, no network.
const ranked = async (notes: string, top: object[], say: string) => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ top, say }) } }] })) as typeof fetch
  const c = (ref: string, name: string, min: number) => ({ ...spot(name), ref, min, legsSec: [] }) as any
  try {
    return await rank('q', { need: 'hospital', limit_type: 'from_now', limit_min: 15, notes }, [c('p3', 'Delhi Heart Institute', 8),
      c('p4', 'Lady Hardinge Emergency Ward', 2), c('p5', 'K.B. Bhabha General Hospital', 5), c('p6', 'Taj Mahal Palace', 12)], [])
  } finally { globalThis.fetch = real }
}
const er = await ranked('emergency', [{ ref: 'p3', reason: 'General hospital with many reviews' }, { ref: 'p5', reason: 'General hospital, close' },
  { ref: 'p4', reason: 'Attacked on 26/11' }], 'x')
assert.deepEqual(er.picks, [{ ref: 'p4', reason: '' }, { ref: 'p5', reason: 'General hospital, close' }, { ref: 'p3', reason: 'hospital with many reviews' }])
assert.equal(er.say, 'Lady Hardinge Emergency Ward: 2 min. K.B. Bhabha General Hospital: 5 min. Delhi Heart Institute: 8 min.')
const sites = await ranked('26/11 sites', [{ ref: 'p6', reason: 'Iconic hotel attacked in 2008' }, { ref: 'p3', reason: 'Close by' }], 'The key 26/11 sites')
assert.deepEqual([sites.picks.map(p => p.reason), sites.say], [['Close by', ''], 'Here are the closest matches.']) // code orders by minutes

// Ride 2026-10-18 (11): the ranker chooses, code orders: ahead of the car nearest first, behind it last.
const road = { fix: { lat: 19, lng: 72.8 }, ahead: { polyline: encode([{ lat: 19, lng: 72.8 }, { lat: 19.1, lng: 72.8 }]), sec: 1800 } }
assert.deepEqual([{ lat: 18.95, lng: 72.8 }, { lat: 19.05, lng: 72.801 }, { lat: 19.0005, lng: 72.81 }, { lat: 18.99, lng: 72.81 }].map(l => behind(l, road)),
  [true, false, false, true])
assert.equal(behind({ lat: 18.95, lng: 72.8 }, { ...road, ahead: null }), false)
const metro = async (top: object[], say: string, from_dest = false) => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ top, say }) } }] })) as typeof fetch
  const c = (ref: string, name: string, min: number, back = false) => ({ ...spot(name), ref, min, legsSec: [], ...(back && { behind: true }), ...(from_dest && { from_dest: true }) }) as any
  try {
    return await rank('q', { need: 'metro station', limit_type: from_dest ? 'near_destination' : 'from_now', limit_min: 15 },
      [c('p57', 'Airoli', 8), c('p59', 'Rabale', 14), c('p60', 'Balkum Metro', 6, true)], [])
  } finally { globalThis.fetch = real }
}
assert.deepEqual((await metro([{ ref: 'p60' }, { ref: 'p59' }, { ref: 'p57' }], 'x')).picks.map(p => p.ref), ['p57', 'p59', 'p60'])
// 10: minutes from the destination never read as "away".
assert.equal((await metro([{ ref: 'p57' }], 'Navi Mumbai Airport is 20 minutes away, the main one 49 min.', true)).say,
  'Navi Mumbai Airport is 20 minutes from the destination, the main one 49 min from the destination.')

// F: a car repair search drops two-wheeler garages (named ones stay).
const garage = (name: string) => ({ ...hit(name, 4.5), place_id: name })
const fixes = await findStops({ searchNear: async () => ['Rehal Two Wheeler Garage', 'Hasmukh bike garage', 'SS Car Garage', 'Scooty Point'].map(garage) } as any,
  from, { need: 'clutch repair', limit_type: 'from_now', limit_min: 15 })
assert.deepEqual(fixes.map(c => c.name), ['SS Car Garage'])

console.log('agent ok')
