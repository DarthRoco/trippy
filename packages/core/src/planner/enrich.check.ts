// Run: node packages/core/src/planner/enrich.check.ts   (no network: fetch is stubbed; nothing here can reach Tavily)
import assert from 'node:assert/strict'
import { cache } from './cache.ts'
cache.on = false // these checks fake different answers to the same request; the cache is checked in plan.check.ts
import { enrich, enrichPlace, googleFacts, GOOGLE_FIELDS, MIN_CLAIM_WORDS, PROMPT, TOP_PER_TYPE } from './enrich.ts'
import { maps_url } from './types.ts'
import type { Constraints, PlannerPlace } from './types.ts'

// Both relay paths are stubbed: /search/evidence answers with Tavily's JSON, /llm with a message.
const sent: { path: string; body: any }[] = []
let tavily: (query: string) => unknown = () => ({ results: [] })
let llm: (user: string) => string = () => '{}'
let fail = false
globalThis.fetch = (async (url: any, init: any) => {
  const path = new URL(String(url)).pathname, body = JSON.parse(init.body)
  sent.push({ path, body })
  if (fail) return new Response('{"error":"boom"}', { status: 500 })
  return new Response(JSON.stringify(path === '/llm' ? { choices: [{ message: { content: llm(body.messages[1].content) } }] } : tavily(body.query)))
}) as typeof fetch
const calls = (path: string) => sent.filter(s => s.path === path)
const reset = () => { sent.length = 0; fail = false; tavily = () => ({ results: [] }); llm = () => '{}' }

const URL1 = 'https://example.com/review'
const place = (id: string, extra: Partial<PlannerPlace> = {}): PlannerPlace =>
  ({ place_id: id, name: 'Cafe', location: { lat: 0, lng: 0 }, open: null, attributes: {}, evidence: [], ...extra })
const answer = (attributes: object, evidence: object[]) => JSON.stringify({ attributes, evidence })

assert.equal(TOP_PER_TYPE, 5)
assert.equal(MIN_CLAIM_WORDS, 4)
assert.deepEqual(Object.keys(GOOGLE_FIELDS), ['parking', 'outdoor'])
assert.ok(PROMPT.startsWith('You read web snippets about one place and judge attributes.') && PROMPT.endsWith('a url copied from the snippets.'))

// Port of test_keeps_only_asked_cited_attributes: an invented attribute and a one-word claim are dropped.
reset()
tavily = () => ({ results: [{ url: URL1, title: '', content: 'text' }] })
llm = () => answer({ quiet: true, grandOpeningDate: true, 'good for working': true }, [
  { attribute: 'quiet', claim: 'The cafe is calm on weekday afternoons', url: URL1 },
  { attribute: 'grandOpeningDate', claim: 'Opened in the year 2019 in town', url: URL1 },
  { attribute: 'good for working', claim: 'Quiet', url: URL1 },
])
let p = place('p1')
await enrichPlace(p, 'Indiranagar', ['quiet', 'good for working'])
assert.deepEqual(p.attributes, { quiet: true })
assert.deepEqual(p.evidence, [{ attribute: 'quiet', claim: 'The cafe is calm on weekday afternoons', url: URL1 }])
// What we asked: one search, then Super reads the snippets with the exact prompt, reasoning off, 700 tokens.
assert.deepEqual(sent.map(s => s.path), ['/search/evidence', '/llm'])
assert.deepEqual(sent[0].body, { query: 'Cafe Indiranagar quiet good for working' })
assert.deepEqual(sent[1].body, { model: 'nvidia/nemotron-3-super-120b-a12b', temperature: 0, max_tokens: 700, chat_template_kwargs: { enable_thinking: false },
  messages: [{ role: 'system', content: PROMPT },
    { role: 'user', content: `Place: Cafe, Indiranagar\nAttributes to judge: quiet, good for working\n\nURL: ${URL1}\ntext` }] })

// Port of test_google_answers_parking_without_a_search.
reset()
p = place('p2', { parking: true })
await enrichPlace(p, 'Indiranagar', ['easy parking'])
assert.deepEqual(p.attributes, { 'easy parking': true })
assert.ok(p.evidence[0].url.endsWith('place_id:p2'))
assert.equal(p.evidence[0].claim, 'Google Maps lists parking here')
assert.equal(sent.length, 0)
p = place('p2b', { parking: false, outdoor_seating: true })
await enrichPlace(p, 'Indiranagar', ['parking nearby', 'outdoor seating'])
assert.deepEqual(p.attributes, { 'parking nearby': false, 'outdoor seating': true })
assert.deepEqual(p.evidence.map(e => e.claim), ['Google Maps lists no parking here', 'Google Maps lists outdoor seating here'])
assert.equal(sent.length, 0)

// Port of test_web_off_never_calls_tavily: Google still answers what it can.
p = place('p3', { parking: true })
await enrichPlace(p, 'Indiranagar', ['easy parking', 'quiet'], false)
assert.deepEqual(p.attributes, { 'easy parking': true })
assert.equal(sent.length, 0)
assert.deepEqual([...googleFacts(place('p4'), ['easy parking'])], []) // Google gave no parking answer, so none
// Google answered one want; only the other goes to the web.
p = place('p5', { parking: true })
tavily = () => ({ results: [{ url: URL1, content: 'text' }] })
llm = () => answer({ quiet: true }, [{ attribute: 'Quiet', claim: 'Calm on weekday afternoons, say reviewers', url: URL1 }])
await enrichPlace(p, 'Indiranagar', ['easy parking', 'quiet'])
assert.equal(calls('/search/evidence')[0].body.query, 'Cafe Indiranagar quiet')
assert.deepEqual(p.attributes, { 'easy parking': true, quiet: true })

// A failed search or model call, or nonsense back, leaves the place as it was.
reset()
fail = true
p = place('p6')
await enrichPlace(p, 'Indiranagar', ['quiet'])
assert.deepEqual([p.attributes, p.evidence], [{}, []])
reset()
await enrichPlace(p, 'Indiranagar', ['quiet']) // no results: no model call
assert.deepEqual(sent.map(s => s.path), ['/search/evidence'])
reset()
tavily = () => ({ results: [{ url: URL1, content: 'text' }] })
llm = () => 'I could not tell.'
await enrichPlace(p, 'Indiranagar', ['quiet'])
assert.deepEqual([p.attributes, p.evidence], [{}, []])

// Only the first 4 of Tavily's results are read, each cut to 600 characters; a url that was not shown does not count as a source.
reset()
const urls = [1, 2, 3, 4, 5].map(i => `https://example.com/${i}`)
tavily = () => ({ results: urls.map(url => ({ url, title: 't', content: 'z'.repeat(1000) })) })
llm = () => '<think>{"attributes": {}}</think>Sure! ' + answer({ quiet: true, 'good sunset view': null, 'easy parking': true, outdoor: false },
  [{ attribute: 'quiet', claim: 'Calm and quiet on weekday afternoons', url: urls[4] }, { attribute: 'easy parking', claim: 'Plenty of parking behind the cafe', url: urls[3] }]) + ' Done.'
p = place('p7')
await enrichPlace(p, 'Indiranagar', ['quiet', 'easy parking', 'good sunset view'])
const shown = calls('/llm')[0].body.messages[1].content as string
assert.equal(shown.split('URL: ').length - 1, 4)
assert.ok(shown.includes(urls[3]) && !shown.includes(urls[4]))
assert.ok(shown.includes('z'.repeat(600)) && !shown.includes('z'.repeat(601)))
assert.deepEqual(p.attributes, { 'easy parking': true }) // quiet cited a url that was not shown; null says nothing; outdoor was not asked
// Attribute names match without case.
reset()
tavily = () => ({ results: [{ url: URL1, content: 'text' }] })
llm = () => answer({ Quiet: true }, [{ attribute: 'QUIET', claim: 'Calm on weekday afternoons, say reviewers', url: URL1 }])
p = place('p8')
await enrichPlace(p, 'Indiranagar', ['quiet'])
assert.deepEqual(p.attributes, { quiet: true })

// enrich: trims each list in place, looks each distinct place up once with all it was wanted for, shares the result.
reset()
const c: Constraints = { duration_minutes: 180, start_time: '14:00', day: 'Sunday', area: 'Indiranagar', stops: ['work', 'coffee'], max_travel_minutes: 30,
  budget: 'medium', stay_minutes: {}, assumed: [], must_haves: ['Quiet'] }
const work = ['dup', ...[1, 2, 3, 4, 5, 6, 7].map(i => 'w' + i)].map(id => place(id, { name: id }))
const coffee = ['c1', 'dup', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map(id => place(id, { name: id }))
const [workList, coffeeList] = [work, coffee]
tavily = q => ({ results: [{ url: URL1, content: q }] })
llm = user => answer({ quiet: true, 'good for working': true }, [
  { attribute: 'quiet', claim: `Calm on weekday afternoons for ${user.split('\n')[0]}`, url: URL1 },
  { attribute: 'good for working', claim: `Plenty of power sockets and wifi too`, url: URL1 }])
await enrich([work, coffee], c)
assert.ok(work === workList && coffee === coffeeList)
assert.deepEqual([work.length, coffee.length], [TOP_PER_TYPE, TOP_PER_TYPE])
assert.equal(calls('/search/evidence').length, 9) // 5 + 5 places, 'dup' in both lists once
const dupQueries = calls('/search/evidence').filter(s => s.body.query.startsWith('dup '))
assert.deepEqual(dupQueries.map(s => s.body.query), ['dup Indiranagar good for working quiet']) // the union of its wants, sorted
assert.deepEqual(coffee[0].attributes, { quiet: true }) // a coffee stop has no inherent want
assert.deepEqual(work[1].attributes, { quiet: true, 'good for working': true })
assert.ok(coffee[1] !== work[0] && coffee[1].attributes === work[0].attributes && coffee[1].evidence === work[0].evidence) // shared
assert.equal(coffee[1].evidence.length, 2)

// web = false: still trims, never searches; Google's answers still land.
reset()
const park = [place('a', { parking: true }), ...[1, 2, 3, 4, 5].map(i => place('b' + i))]
await enrich([park], { ...c, stops: ['walk'], must_haves: ['easy parking'] }, false)
assert.equal(park.length, TOP_PER_TYPE)
assert.equal(sent.length, 0)
assert.deepEqual(park[0].attributes, { 'easy parking': true })
assert.equal(park[0].evidence[0].url, maps_url(park[0]))

// What the user wants to buy is asked of the shopping stop's places only, never of the dinner place.
reset()
tavily = q => ({ results: [{ url: URL1, content: q }] })
await enrich([[place('shop', { name: 'shop' })], [place('dinner', { name: 'dinner' })]], { ...c, stops: ['shopping', 'dinner'], must_haves: [], shop_for: 'Statement ring' })
assert.deepEqual(calls('/search/evidence').map(s => s.body.query), ['shop Indiranagar sells statement ring'])
console.log('planner enrich ok')
