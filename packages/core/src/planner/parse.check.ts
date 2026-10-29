// Run: node packages/core/src/planner/parse.check.ts   (no network: fetch is stubbed)
import assert from 'node:assert/strict'
import { cache } from './cache.ts'
cache.on = false // these checks fake different answers to the same request; the cache is checked in plan.check.ts
import { grounded, ParseError, parseRequest, SYSTEM_PROMPT, Unsupported } from './parse.ts'

// /llm answers with the queued message contents, in order; every request is kept.
const sent: { path: string; body: any }[] = []
let queue: string[] = []
globalThis.fetch = (async (url: any, init: any) => {
  sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) })
  return new Response(JSON.stringify({ choices: [{ message: { content: queue.shift() ?? null } }] }))
}) as typeof fetch
const parse = (text: string, ...contents: unknown[]) => {
  sent.length = 0
  queue = contents.map(c => (typeof c === 'string' ? c : JSON.stringify(c)))
  return parseRequest(text)
}

const VALID = { duration_minutes: 180, start_time: '14:00', day: 'Sunday', area: 'Indiranagar', stops: ['coffee', 'work', 'sunset'],
  max_travel_minutes: 30, budget: 'medium', must_haves: ['quiet'] }

// Port of test_parses_valid_json, and the request we send.
const ok = await parse('3 hours Sunday in Indiranagar', VALID)
assert.equal(ok.area, 'Indiranagar')
assert.deepEqual(ok.stops, ['coffee', 'work', 'sunset'])
assert.equal(sent.length, 1)
assert.equal(sent[0].path, '/llm')
assert.deepEqual(sent[0].body, { model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: '3 hours Sunday in Indiranagar' }],
  temperature: 0, chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' } })
assert.ok(SYSTEM_PROMPT.startsWith('You convert an outing request for Bangalore into JSON.\nReturn only'))
assert.ok(SYSTEM_PROMPT.endsWith('Do not compute distances or times. Only read what the request says.'))

// Defaults for what the model leaves out; unknown keys are dropped.
assert.deepEqual(await parse('x', { ...VALID, budget: undefined, must_haves: undefined, extra: 'ignored' }), { ...VALID, budget: 'medium', must_haves: [], stay_minutes: {},
  shop_for: '', named_places: [], unsupported: [], assumed: ['start_time', 'duration_minutes', 'day', 'max_travel_minutes', 'budget'] })

// Port of test_retries_once_after_bad_json.
assert.equal((await parse('x', 'not json', VALID)).duration_minutes, 180)
assert.equal(sent.length, 2)
assert.equal((await parse('x', '', VALID)).duration_minutes, 180) // a null message is an empty answer, so a retry too

// Port of test_raises_after_two_bad_answers: ParseError, after exactly two tries.
await assert.rejects(parse('x', 'not json', { duration_minutes: 0 }), ParseError)
assert.equal(sent.length, 2)
await assert.rejects(parse('x', 'not json', 'not json'), /after 2 tries/)
assert.ok(new ParseError('x') instanceof Error)

// Port of test_rejects_unknown_stop_type, and the other checks Pydantic did.
const bad = (patch: object) => assert.rejects(parse('x', { ...VALID, ...patch }, { ...VALID, ...patch }), ParseError, JSON.stringify(patch))
await bad({ stops: ['bowling'] })
await bad({ stops: [] })
await bad({ stops: undefined })
await bad({ duration_minutes: 0 })
await bad({ duration_minutes: 90.5 })
await bad({ duration_minutes: 'two hours' })
await bad({ start_time: '9am' })
await bad({ start_time: '9:00' })
await bad({ day: 3 })
await bad({ area: undefined })
await bad({ max_travel_minutes: -1 })
await bad({ budget: 'cheap' })
await bad({ budget: null })
await bad({ must_haves: 'quiet' })
await bad({ must_haves: [1] })
const words = { ...VALID, stay_minutes: { work: 'an hour' }, stay_quotes: { work: 'work for an hour' } } // kept by the quote, then not an integer
await assert.rejects(parse('work for an hour', words, words), ParseError)
assert.equal((await parse('x', { ...VALID, max_travel_minutes: 0 })).max_travel_minutes, 0) // 0 is allowed
await assert.rejects(parse('x', '[1]', '"text"'), ParseError) // JSON that is not an object

// Port of test_stay_without_a_quote_from_the_request_is_dropped.
const stay = { ...VALID, stay_minutes: { work: 60, coffee: 45 }, stay_quotes: { work: 'work for an hour', coffee: 'sip slowly' } }
assert.deepEqual((await parse('Coffee then work for an hour', stay)).stay_minutes, { work: 60 })
assert.deepEqual((await parse('Coffee then WORK for an hour', stay)).stay_minutes, { work: 60 }) // quotes match without case
assert.deepEqual((await parse('Coffee then work', { ...stay, stay_quotes: {} })).stay_minutes, {}) // no quote at all

// Port of test_stay_that_only_restates_the_total_duration_is_dropped.
const total = { ...VALID, stay_minutes: { work: 120 }, stay_quotes: { work: 'Two hours' }, duration_quote: 'Two hours' }
assert.deepEqual((await parse('Two hours, a place to work and then dinner', total)).stay_minutes, {})
assert.deepEqual((await parse('Two hours, a place to work for two hours', { ...total, stay_quotes: { work: 'work for two hours' } })).stay_minutes, {}) // as in Python: a quote containing the total phrase goes too
assert.deepEqual((await parse('Three hours out, two hours of it to work', { ...total, duration_quote: 'Three hours out' })).stay_minutes, { work: 120 }) // not the total

// Port of test_only_fields_quoted_from_the_request_count_as_stated.
const said = { ...VALID, stated_quotes: { start_time: 'at 9am', max_travel_minutes: 'made up words', day: 'Sunday' } }
assert.deepEqual((await parse('Sunday coffee at 9am', said)).assumed, ['duration_minutes', 'max_travel_minutes', 'budget'])
assert.deepEqual((await parse('Sunday coffee at 9am', { ...said, stated_quotes: { day: '' } })).assumed, ['start_time', 'duration_minutes', 'day', 'max_travel_minutes', 'budget'])

// grounded on its own: the quote fields are consumed, the rest passes through.
const g = grounded({ ...VALID, stated_quotes: { budget: 'cheap' }, duration_quote: 'x', stay_quotes: {}, stay_minutes: null }, 'a cheap lunch')
assert.deepEqual([g.assumed, g.stay_minutes, 'stated_quotes' in g, 'duration_quote' in g, 'stay_quotes' in g, g.area],
  [['start_time', 'duration_minutes', 'day', 'max_travel_minutes'], {}, false, false, false, 'Indiranagar'])

// No supported stop ("bowling and a movie"): refused at once as Unsupported after one model call, not retried.
await assert.rejects(parse('bowling and a movie', { ...VALID, stops: [] }, VALID), Unsupported)
assert.equal(sent.length, 1)
assert.ok(new Unsupported('x') instanceof ParseError) // callers that only know ParseError still catch it
// Broken output is still retried once.
await assert.rejects(parse('x', 'not json', 'not json'), (e: unknown) => e instanceof ParseError && !(e instanceof Unsupported))
assert.equal(sent.length, 2)

// Shruti's request (2026-10-22): a ring to buy before dinner at a named place at 7pm. The named place keeps its time
// (not the outing start), what to buy is kept in her words, and the name is not taken for a coffee stop.
const kopitiam = 'i have a plan to go to Kopitiam lah on ssaturday at 7pm in indiranagr. Before that i want to by a nice ring for my finger as a statement piece. Demi fine or semi precious jewellery any suggestions?'
const ring = await parse(kopitiam, { ...VALID, stops: ['shopping', 'dinner'], start_time: '16:00', day: 'Saturday', must_haves: [],
  shop_for: ' demi fine or semi precious statement ring ', named_places: [{ name: 'Kopitiam Lah', stop: 'dinner', time: '19:00' }], unsupported: [] })
assert.deepEqual([ring.stops, ring.shop_for, ring.named_places, ring.unsupported],
  [['shopping', 'dinner'], 'demi fine or semi precious statement ring', [{ name: 'Kopitiam Lah', stop: 'dinner', time: '19:00' }], []])
assert.ok(SYSTEM_PROMPT.includes('lunch, snack, walk, bar, shopping)') && SYSTEM_PROMPT.includes('not start_time'))
// A name not copied from the request is dropped (the model never names a place for the user); a bad stop type or time
// is dropped too; a named place whose stop the model left out of stops joins at the end; one per stop type.
const names = (named_places: unknown, stops = ['dinner']) => parse('dinner at Toit, then a bar', { ...VALID, stops, named_places })
assert.deepEqual((await names([{ name: 'Toit Brewpub', stop: 'dinner', time: '' }])).named_places, [])
assert.deepEqual((await names([{ name: 'toit', stop: 'movie', time: '' }, { name: 'Toit', stop: 'dinner', time: '8pm' }])).named_places,
  [{ name: 'Toit', stop: 'dinner', time: '' }])
assert.deepEqual((await names([{ name: 'Toit', stop: 'bar', time: '22:00' }])).stops, ['dinner', 'bar'])
assert.deepEqual((await names([{ name: 'Toit', stop: 'dinner', time: '' }, { name: 'Toit', stop: 'dinner', time: '20:00' }])).named_places?.length, 1)
assert.deepEqual((await names('Toit')).named_places, []) // not a list
// A kind of place in the area is not a name (the model said "dinner in Koramangala" was one); a real name in it is.
const kind = (name: string) => parse(`movie then ${name}`, { ...VALID, area: 'Koramangala', stops: ['dinner'], named_places: [{ name, stop: 'dinner', time: '' }] })
assert.deepEqual((await kind('dinner in Koramangala')).named_places, [])
assert.deepEqual((await kind('a restaurant near Koramangala')).named_places, [])
assert.deepEqual((await kind('Koramangala Social')).named_places, [{ name: 'Koramangala Social', stop: 'dinner', time: '' }])
// Activities with no stop type are listed, not planned; one the model put in stops anyway moves there, without a retry.
const movie = await parse('a movie then dinner', { ...VALID, stops: ['movie', 'dinner'], unsupported: ['movie', ' ', 3] })
assert.deepEqual([movie.stops, movie.unsupported, sent.length], [['dinner'], ['movie'], 1])
assert.deepEqual((await parse('watch a movie, then dinner', { ...VALID, stops: ['movie', 'dinner'], unsupported: ['watch a Movie'] })).unsupported, ['watch a Movie']) // said once
await assert.rejects(parse('a movie', { ...VALID, stops: ['movie'] }, VALID), Unsupported) // nothing left to plan
assert.equal(sent.length, 1)

// R6b #110: the model put the time in the name ("Kopitiam Lah at 7pm", copied from an old prompt example, for a
// request at 7:30pm). The time is cut off the name before it is checked against the request and looked up.
const tail = await parse('Plan an evening in Indiranagar: sunset spot then dinner at Kopitiam Lah at 7:30pm', { ...VALID, stops: ['sunset', 'dinner'],
  named_places: [{ name: 'Kopitiam Lah at 7pm', stop: 'dinner', time: '19:30' }] })
assert.deepEqual(tail.named_places, [{ name: 'Kopitiam Lah', stop: 'dinner', time: '19:30' }])
for (const name of ['Toit at 8 pm', 'Toit at 8:30pm', 'Toit by 8', 'Toit @ 8.30 PM'])
  assert.equal((await names([{ name, stop: 'dinner', time: '20:00' }])).named_places?.[0]?.name, 'Toit', name)
assert.ok(!SYSTEM_PROMPT.includes('Kopitiam Lah at 7pm') && SYSTEM_PROMPT.includes('never includes its time'))

// R6b #101: Shruti's request once came back as a coffee stop at Kopitiam Lah at 19:00 and the ring as unsupported.
// A named place whose type the user never said takes its meal from its time, in stops too; a thing to buy is not
// an unsupported activity when shopping is planned.
const coffee = await parse(kopitiam, { ...VALID, stops: ['shopping', 'coffee'], shop_for: 'demi fine or semi precious statement ring',
  named_places: [{ name: 'Kopitiam lah', stop: 'coffee', time: '19:00' }], unsupported: ['ring', 'a movie'] })
assert.deepEqual([coffee.stops, coffee.named_places, coffee.unsupported],
  [['shopping', 'dinner'], [{ name: 'Kopitiam lah', stop: 'dinner', time: '19:00' }], ['a movie']])
const typed = (text: string, stop: string, time: string) => parse(text, { ...VALID, stops: [stop], named_places: [{ name: 'Toit', stop, time }] })
assert.deepEqual((await typed('Toit at 1pm', 'bar', '13:00')).stops, ['lunch'])
assert.equal((await typed('drinks at Toit at 9pm', 'bar', '21:00')).named_places?.[0].stop, 'bar') // she said drinks
assert.equal((await typed('Toit at 4pm', 'bar', '16:00')).named_places?.[0].stop, 'bar') // no meal at 16:00
assert.equal((await typed('coffee at Toit at 7pm', 'coffee', '19:00')).named_places?.[0].stop, 'coffee')
// A thing bought counts after a buy word too, even when shop_for words it differently; without shopping it stays.
assert.deepEqual((await parse('I want to get some earrings, then a movie', { ...VALID, stops: ['shopping'], shop_for: 'jewellery', unsupported: ['earrings', 'movie'] })).unsupported, ['movie'])
assert.deepEqual((await parse('a ring, then a movie', { ...VALID, stops: ['dinner'], unsupported: ['ring'] })).unsupported, ['ring'])

// R6b #109: the model named "Spa" as a place and made a work stop for it. An activity is never a named place: it goes
// to unsupported, and the stop made up for it goes too, unless the user asked for that stop type themselves.
const spa = await parse('Spa and then dinner in Koramangala', { ...VALID, area: 'Koramangala', stops: ['work', 'dinner'], unsupported: [],
  named_places: [{ name: 'Spa', stop: 'work', time: '' }] })
assert.deepEqual([spa.stops, spa.named_places, spa.unsupported], [['dinner'], [], ['Spa']])
assert.deepEqual((await parse('Spa, then work and dinner', { ...VALID, stops: ['work', 'dinner'], unsupported: ['spa'], named_places: [{ name: 'Spa', stop: 'work', time: '' }] }))
  .stops, ['work', 'dinner']) // she said work
assert.deepEqual((await parse('a movie at PVR Cinemas, then dinner', { ...VALID, stops: ['dinner'], named_places: [{ name: 'PVR Cinemas', stop: 'dinner', time: '' }] })).unsupported,
  ['PVR Cinemas'])
assert.deepEqual((await parse('Spa, then work', { ...VALID, unsupported: ['spa'], named_places: [{ name: 'Spa', stop: 'work', time: '' }] })).unsupported, ['Spa']) // once
await assert.rejects(parse('A spa day in Koramangala', { ...VALID, stops: ['work'], named_places: [{ name: 'spa', stop: 'work', time: '' }] }, VALID), Unsupported)
assert.equal(sent.length, 1) // nothing left to plan: said at once, not retried
assert.deepEqual((await names([{ name: 'Toit', stop: 'dinner', time: '' }])).named_places, [{ name: 'Toit', stop: 'dinner', time: '' }]) // a real name stays
console.log('planner parse ok')
