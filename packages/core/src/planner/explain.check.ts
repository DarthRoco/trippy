// Run: node packages/core/src/planner/explain.check.ts   (no network: fetch is stubbed)
import assert from 'node:assert/strict'
import { cache } from './cache.ts'
cache.on = false // these checks fake different answers to the same request; the cache is checked in plan.check.ts
import { addReasons, applies, claimDays, claimHours, CLOSING_MATTERS, explainStop, facts, fallback, PROMPT } from './explain.ts'
import type { Itinerary, PlannerPlace, Stop } from './types.ts'

const sent: any[] = []
let say: (user: string) => string | null = () => 'A calm cafe.'
let fail = false
globalThis.fetch = (async (url: any, init: any) => {
  const body = JSON.parse(init.body)
  sent.push({ path: new URL(String(url)).pathname, body })
  if (fail) return new Response('{"error":"boom"}', { status: 500 })
  return new Response(JSON.stringify({ choices: [{ message: { content: say(body.messages[1].content) } }] }))
}) as typeof fetch

const place = (id: string, extra: Partial<PlannerPlace> = {}): PlannerPlace =>
  ({ place_id: id, name: 'Third Wave', location: { lat: 0, lng: 0 }, open: null, attributes: {}, evidence: [], ...extra })
const stop = (p: PlannerPlace, extra: Partial<Stop> = {}): Stop =>
  ({ stop_type: 'coffee', place: p, arrive: 840, depart: 900, travel_from_prev_min: 0, warnings: [], reason: '', closes: null, ...extra })
const it = (...stops: Stop[]): Itinerary => ({ stops, total_minutes: 0, score: 0, warnings: [], start_min: 840 })

assert.equal(CLOSING_MATTERS, 90)
assert.ok(PROMPT.startsWith('Write one plain sentence of at most 22 words') && PROMPT.endsWith('Return only the sentence.'))

// facts: the lines the model may use, in order.
const rich = place('a', { type: 'coffee_shop', rating: 4.5, reviews: 321, evidence: [{ attribute: 'quiet', claim: 'Calm on weekday afternoons', url: 'u' }, { attribute: 'x', claim: 'Has power sockets', url: 'v' }] })
assert.equal(facts(stop(rich, { travel_from_prev_min: 7, closes: 930 })),
  'Stop: coffee\nPlace: Third Wave\nKind of place: coffee shop\nGoogle rating: 4.5 from 321 reviews\nTravel from the previous stop: 7 minutes\n' +
  'Open until 15:30\nEvidence: Calm on weekday afternoons\nEvidence: Has power sockets')
assert.ok(!facts(stop(rich, { closes: 900 + 91 })).includes('Open until')) // a far-off closing time says nothing
assert.ok(facts(stop(rich, { closes: 900 + 90 })).includes('Open until 16:30'))
assert.ok(facts(stop(rich, { closes: 1500, depart: 1440 })).includes('Open until 01:00')) // past midnight wraps
assert.ok(!facts(stop(rich, { closes: null })).includes('Open until'))
assert.equal(facts(stop(place('b', { rating: 4 }))), 'Stop: coffee\nPlace: Third Wave\nGoogle rating: 4.0 from 0 reviews') // 4.0 as Python printed it
assert.ok(facts(stop(place('b'))).includes('Google rating: None from 0 reviews'))

// fallback: the first evidence claim, else the rating, else nothing.
assert.equal(fallback(stop(rich)), 'Calm on weekday afternoons')
assert.equal(fallback(stop(place('b', { rating: 4.2, reviews: 90 }))), 'Rated 4.2 from 90 Google reviews.')
assert.equal(fallback(stop(place('b'))), 'No evidence found.')

// explainStop: asks with the exact prompt, 200 tokens, reasoning off; cleans the answer; falls back when it cannot.
say = () => '<think>hmm</think>\n  "Calm spot with sockets, 7 minutes away."  '
assert.equal(await explainStop(stop(rich)), 'Calm spot with sockets, 7 minutes away.')
assert.equal(sent[0].path, '/llm')
assert.deepEqual(sent[0].body, { model: 'nvidia/nemotron-3-super-120b-a12b', temperature: 0, max_tokens: 200, chat_template_kwargs: { enable_thinking: false },
  messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: facts(stop(rich)) }] })
say = () => ''
assert.equal(await explainStop(stop(rich)), 'Calm on weekday afternoons')
say = () => null
assert.equal(await explainStop(stop(place('b'))), 'No evidence found.')
say = () => '"'
assert.equal(await explainStop(stop(place('b', { rating: 4.5, reviews: 2 }))), 'Rated 4.5 from 2 Google reviews.')
fail = true
assert.equal(await explainStop(stop(rich)), 'Calm on weekday afternoons')
fail = false

// addReasons: one call per distinct (place, stop type) across all itineraries, every stop filled.
sent.length = 0
say = user => 'Reason for ' + user.split('\n').slice(0, 2).join(' / ')
const [a, b] = [place('a', { name: 'A' }), place('b', { name: 'B' })]
const plans = [it(stop(a), stop(b, { stop_type: 'dinner' })), it(stop(a), stop(a, { stop_type: 'work' })), it(stop(b, { stop_type: 'dinner' }))]
await addReasons(plans)
assert.equal(sent.length, 3) // a-coffee, b-dinner, a-work
assert.deepEqual(plans.flatMap(p => p.stops.map(s => s.reason)), [
  'Reason for Stop: coffee / Place: A', 'Reason for Stop: dinner / Place: B',
  'Reason for Stop: coffee / Place: A', 'Reason for Stop: work / Place: A',
  'Reason for Stop: dinner / Place: B'])
sent.length = 0
await addReasons([]) // nothing to explain, nothing asked
assert.equal(sent.length, 0)

// Claims that do not hold for the visit (Shruti's Saturday dinner was told of a Monday-to-Thursday corporate offer).
assert.deepEqual([...claimDays('Flat 20% off Monday–Thursday for corporate groups')!], [1, 2, 3, 4])
assert.deepEqual([...claimDays('Mon-Fri lunch buffet')!], [1, 2, 3, 4, 5])
assert.deepEqual([...claimDays('Brunch fri to sun')!], [5, 6, 0]) // a range wraps past Saturday
assert.deepEqual([...claimDays('Live music on weekends and Wednesdays')!], [0, 6, 3])
assert.equal(claimDays('We sat in the sun at sunset, Wed was great'), null) // short names alone are plain words
assert.deepEqual(claimHours('Happy hour 4-7 pm'), [16 * 60, 19 * 60])
assert.deepEqual(claimHours('Brunch 11:30am to 3pm'), [690, 900])
assert.deepEqual(claimHours('Kitchen 18:00-23:00'), [1080, 1380])
assert.deepEqual(claimHours('Open 7 pm to 1 am'), [1140, 1500]) // past midnight
assert.equal(claimHours('Tables for 2-4 people'), null)
const SAT = 6, seven = 19 * 60, quarterPast8 = 20 * 60 + 15
assert.equal(applies('Flat 20% off Monday–Thursday for corporate groups', SAT, seven, quarterPast8), false)
assert.equal(applies('Happy hour 4-7 pm', SAT, seven, quarterPast8), false) // ends as the visit starts
assert.equal(applies('Live jazz on Saturdays from 8 to 11 pm', SAT, seven, quarterPast8), true)
assert.equal(applies('Late night menu 12am-2am', SAT, 23 * 60, 24 * 60 + 30), true)
assert.equal(applies('Cosy booths and good noodles', SAT, seven, quarterPast8), true)

// With the visit given, facts keep only claims that hold for it.
const offers = place('k', { evidence: [{ attribute: 'x', claim: 'Flat 20% off Monday–Thursday', url: 'u' }, { attribute: 'y', claim: 'Laksa is a favourite here', url: 'v' }] })
assert.equal(facts(stop(offers, { stop_type: 'dinner', arrive: seven, depart: quarterPast8 }), { weekday: SAT, shop_for: 'a ring' }),
  'Stop: dinner\nPlace: Third Wave\nGoogle rating: None from 0 reviews\nEvidence: Laksa is a favourite here')
// What she wants to buy is told only for a shop whose name or evidence mentions it, so no other shop is said to sell it.
const wants = (p: PlannerPlace) => facts(stop(p, { stop_type: 'shopping' }), { weekday: SAT, shop_for: 'demi fine or semi precious statement ring' })
assert.ok(wants(place('s', { name: 'Sorele | Premium Demi-Fine' })).includes('\nThe user wants to buy: demi fine or semi precious statement ring\n'))
assert.ok(wants(place('s', { name: 'Gem Shop', evidence: [{ attribute: 'x', claim: 'Many silver rings on display', url: 'u' }] })).includes('The user wants to buy'))
assert.ok(!wants(place('s', { name: 'Gemstone Selections' })).includes('The user wants to buy'))
assert.equal(fallback(stop(place('k', { evidence: [offers.evidence[0]] }), { arrive: seven }), { weekday: SAT }), 'No evidence found.')
assert.ok(PROMPT.includes('corporate groups'))
// addReasons passes the visit on, and the user's own place gets no reason (and no model call): they chose it.
sent.length = 0
say = () => 'Reason.'
const mine = it(stop(place('r', { name: 'Ring Studio' }), { stop_type: 'shopping' }), stop(b, { stop_type: 'dinner', own: true }))
await addReasons([mine], { weekday: SAT, shop_for: 'a ring' })
assert.equal(sent.length, 1)
assert.ok(sent[0].body.messages[1].content.includes('The user wants to buy: a ring'))
assert.deepEqual(mine.stops.map(s => s.reason), ['Reason.', ''])
console.log('planner explain ok')
