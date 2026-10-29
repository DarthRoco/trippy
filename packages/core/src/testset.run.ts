// TESTSET.md (bus): requests on 3 routes through the real agent loop (ask), on trip model v2 trips. Each request passes
// when a wanted tool appears in the turn, all needed steps appear, and the args check out. find_stops turns run end to
// end (B+ search + Ultra rank). Costs tokens and Places calls. Needs the proxy running.
// Run: node packages/core/src/testset.run.ts [only-ids, e.g. 1,9,27]
import { api } from './api.ts'
import { ABSENT, ask, META, PROMISE, type Memory, type Step } from './agent.ts'
import { findStops } from './find_stops.ts'
import { googleProvider as g } from './google.ts'
import { cut, decode } from './geo.ts'
import { ahead, newTrip, nextSteps, routeAhead, upsertPlaces } from './context.ts'
import { deadlineTimes, istIso } from './time.ts'
import type { FindStopsArgs, MapProvider, Message, Note, Place, Search, Trip } from './types.ts'

const realFetch = globalThis.fetch // the proxy only answers allowed browser origins
// Calls made by this run (the model-call budget): printed at the end.
const calls = { super: 0, ultra: 0, maps: 0, search: 0 }
globalThis.fetch = (url, init) => {
  const u = String(url)
  if (u.endsWith('/llm')) calls[/super/i.test(String(init?.body).slice(0, 120)) ? 'super' : 'ultra']++
  else if (u.includes('/maps/')) calls.maps++
  else if (u.endsWith('/search')) calls.search++
  return realFetch(url, { ...init, headers: { ...init?.headers, Origin: 'http://localhost:5173' } })
}
api.base = 'http://localhost:8787'

const ROUTES = [
  ['Kurla West, Mumbai', "Domino's Pizza, Juhu Beach, Mumbai"],
  ['IIT Bombay, Powai', 'Chhatrapati Shivaji Maharaj International Airport Terminal 2, Mumbai'],
  ['Bandra West, Mumbai', 'Gateway of India, Mumbai'],
]
const PROFILE = [{ id: 'n1', text: 'Dad is vegetarian' }]

type A = Record<string, any>
type Get = (name: string) => A // args of the first step with that name ({} if none)
// What a check can look at besides the steps: the reply, the steps, the trip the request ran on, the progress lines,
// the search this turn stored (if any) and the names of the places shown as cards.
type Run = { text: string; steps: Step[]; trip: Trip; progress: string[]; search?: Search; names: string[]; memory: Memory }
// top: outcome check, at least one shown place name contains one of these words (lowercase). profile: replaces PROFILE.
type Case = { id: number; text: string; ctx?: 'followup' | 'notrip' | 'trishna' | 'ngma' | 'onlink' | 'religious' | 'hajiali' | 'delhi' | 'ngmalist' | 'stops' | 'stale' | 'juice' | 'toddler' | 'moved';
  want: string[]; needs?: string[]; check?: (get: Get, run: Run) => string | null; top?: string[]; profile?: Note[] }
// Refs of the cards of the trip's latest search (what "#1", "the second one" point at).
const cardRefs = (t: Trip) => t.searches.at(-1)?.picks.map(p => p.ref) ?? []
const REF_IN_TEXT = /\b[pr]\d{1,2}\b/i // refs are never shown to users
// Raw provider values in a reply (#47): price enums, snake_case field names, true / false / null as words.
const RAW_REPLY = /\b(PRICE_LEVEL_\w+|FREE|INEXPENSIVE|MODERATE|EXPENSIVE|VERY_EXPENSIVE)\b|\b[a-z]+_[a-z_]+\b|\b(true|false|null)\b/
// Latin letters, punctuation and symbols (₹, ★) pass; Devanagari and the like do not (#46).
const NON_LATIN = /[^\u0000-ɏ -⯿]/
const nonLatin = (xs: string[]) => { const bad = xs.filter(s => NON_LATIN.test(s)); return bad.length ? `non-Latin: ${bad.join(' | ')}` : null }
const has = (a: A, k: string, ...words: string[]) =>
  words.some(w => String(a[k] ?? '').toLowerCase().includes(w)) ? null : `${k}=${JSON.stringify(a[k])}, wanted ${words.join('|')}`
const is = (a: A, k: string, v: unknown) => (a[k] === v ? null : `${k}=${JSON.stringify(a[k])}, wanted ${v}`)
const all = (...r: (string | null)[]) => r.filter(Boolean).join('; ') || null
const fs = (get: Get) => get('find_stops')

const CASES: Case[] = [
  { id: 1, text: "Headed to Domino's Juhu, 1.5 h traffic, find similar places on the way, within 15-20 min, dad is angry",
    want: ['find_stops'], check: g => all(has(fs(g), 'need', 'pizza'), is(fs(g), 'limit_type', 'from_now')) },
  { id: 2, text: 'Anything veg nearby? 10 min max', want: ['find_stops'],
    check: g => all(has(fs(g), 'need', 'veg'), is(fs(g), 'limit_type', 'from_now'), is(fs(g), 'limit_min', 10)) },
  { id: 3, text: 'bhai jaldi koi veg place batao 10 min mein', want: ['find_stops'],
    check: g => all(has(fs(g), 'need', 'veg'), is(fs(g), 'limit_type', 'from_now'), is(fs(g), 'limit_min', 10)) },
  { id: 4, text: 'Dad wants thali, kids want pizza, one place for both', want: ['find_stops'] },
  { id: 5, text: 'Something under 500 per person', ctx: 'followup', want: ['find_stops', 'reply'] },
  { id: 6, text: 'Only places with at least 4.3 rating and lots of reviews', ctx: 'followup', want: ['find_stops', 'reply'] },
  { id: 7, text: "Don't want a detour more than 10 extra minutes", ctx: 'followup', want: ['find_stops'],
    check: g => all(is(fs(g), 'limit_type', 'detour'), is(fs(g), 'limit_min', 10)) },
  { id: 8, text: 'Traffic got worse, is it still worth going there?', want: ['eta_from_here', 'reply'] },
  { id: 9, text: 'Tell me more about the second one', ctx: 'followup', want: ['place_details'],
    check: (g, r) => is(g('place_details'), 'ref', cardRefs(r.trip)[1]) },
  { id: 10, text: 'Will #1 still be open when we get there?', ctx: 'followup', want: ['place_details', 'eta_from_here'] },
  { id: 11, text: 'Does #3 have parking?', ctx: 'followup', want: ['place_details', 'web_search'] },
  { id: 12, text: 'How long is the wait for a table there?', ctx: 'followup', want: ['reply', 'place_details', 'web_search'] },
  { id: 13, text: 'Is #2 actually famous or just okay?', ctx: 'followup', want: ['web_search'] },
  // v2: the follow-up trip has two searches (pizza, then veg); "the first set" is the pizza one.
  { id: 14, text: 'Go back to the first set of options you showed', ctx: 'followup', want: ['reply', 'get_trip_state'],
    check: (_, r) => {
      const first = r.trip.searches[0].picks.map(p => r.trip.places[p.ref].name.toLowerCase().split(/[ ,]/)[0])
      return first.some(w => r.text.toLowerCase().includes(w)) ? null : `reply names none of the first set (${first.join('|')})`
    } },
  // Buttons are named as shown (Open in Maps, Uber, WhatsApp), never "the Maps button" (Sprint 2).
  { id: 15, text: "Okay let's do #1, send to family", ctx: 'followup', want: ['make_link'],
    check: (g, r) => is(g('make_link'), 'ref', cardRefs(r.trip)[0]) ??
      (/\bmaps\b/i.test(r.text) && !/open in maps/i.test(r.text) ? 'reply names a Maps button not shown' : null) },
  { id: 16, text: 'Change the Uber to go there', ctx: 'followup', want: ['make_link', 'reply'] },
  { id: 17, text: 'Tyre punctured, anywhere nearby to fix it?', want: ['find_stops'],
    check: g => all(has(fs(g), 'need', 'tyre', 'tire', 'puncture'), is(fs(g), 'limit_type', 'from_now')) },
  { id: 18, text: 'Need a clean washroom for grandma', want: ['find_stops'] },
  { id: 19, text: 'Nearest ATM on the way', want: ['find_stops'], check: g => has(fs(g), 'need', 'atm') },
  { id: 20, text: 'CNG pump before we get on the highway', want: ['find_stops'], check: g => has(fs(g), 'need', 'cng') },
  { id: 21, text: 'Where are we? Which road comes next?', want: ['reply'] },
  // Notes default to this trip; the profile only when the user says to keep it (ride finding 6, 2026-10-21). #71 is the profile case.
  { id: 22, text: 'Mom is allergic to seafood, remember that', want: ['remember'],
    check: (_, r) => r.memory.add.length && r.memory.add.every(n => n.scope === 'trip') ? null : `saved as ${JSON.stringify(r.memory.add.map(n => n.scope))}, wanted trip` },
  { id: 71, text: 'Mom is allergic to seafood, always remember that for every trip', want: ['remember'],
    check: (_, r) => r.memory.add.some(n => n.scope === 'profile') ? null : `saved as ${JSON.stringify(r.memory.add.map(n => n.scope))}, wanted profile` },
  { id: 23, text: 'Forget that dad is vegetarian, he eats chicken now', want: ['forget'], needs: ['forget', 'remember'],
    check: g => is(g('forget'), 'note_id', 'n1') },
  { id: 24, text: 'We leave at 7 pm for Trishna, is that a bad idea?', ctx: 'trishna', want: ['eta_from_here'],
    check: g => (g('eta_from_here').depart_at ? null : 'no depart_at') },
  { id: 25, text: 'Airport by 6, want to eat on the way, 30 min max stop', want: ['find_stops'] },
  { id: 26, text: "We're hungry, no destination, what's close?", ctx: 'notrip', want: ['find_stops'] }, // a real G2 trip at the route start
  { id: 27, text: 'Accident, dad is hurt', want: ['find_stops'], check: g => has(fs(g), 'need', 'hospital') },
  { id: 28, text: 'Car is smoking, what do I do?', want: ['reply', 'find_stops'] },
  { id: 29, text: 'Book a table at #1', ctx: 'followup', want: ['place_details', 'make_link', 'reply'] }, // Maps listing has the phone
  { id: 30, text: 'Find a route with no traffic', want: ['reply'] },
  // User test 2026-10-03: a sights question near the destination came back empty (from_now 15 on a 74-min trip).
  { id: 31, text: 'Any iconic places related to mumbai history or lets say 9/11 attack I can go to?', ctx: 'ngma', want: ['find_stops'],
    top: ['taj', 'leopold', 'nariman', 'trident', 'terminus', 'gateway', 'sangrahalaya'] },
  { id: 32, text: 'We want to see the 26/11 attack sites near where we are going', ctx: 'ngma', want: ['find_stops'],
    top: ['taj', 'leopold', 'nariman', 'trident', 'oberoi', 'cama', 'terminus'] },
  // Same spirit as #31-32 (user tests 2026-10-03): casual wording, sights / history / people near the destination,
  // misremembered names, Hinglish. Each checks what is actually shown, not just the tool.
  { id: 33, text: 'kids are obsessed with trains, anything train related to see once we reach?', ctx: 'ngma', want: ['find_stops'],
    top: ['terminus', 'railway', 'station', 'rail'] },
  { id: 34, text: 'my nana worked in the cotton mills back in the day, anywhere we can see that history?', ctx: 'ngma', want: ['find_stops'],
    top: ['mill', 'textile', 'girangaon', 'museum', 'sangrahalaya'] },
  { id: 35, text: 'wife wants to see where Shah Rukh Khan lives, can we swing by?', ctx: 'ngma', want: ['find_stops'], top: ['mannat'] },
  { id: 36, text: 'something Gandhi related to visit after we get there?', ctx: 'ngma', want: ['find_stops'], top: ['mani bhavan', 'gandhi'] },
  { id: 37, text: 'is there a nice sunset spot near where we are headed?', ctx: 'ngma', want: ['find_stops'],
    top: ['marine drive', 'chowpatty', 'nariman point', 'sunset', 'gateway', 'promenade'] },
  { id: 38, text: 'dad is a finance guy, he wants to see the old stock exchange building', ctx: 'ngma', want: ['find_stops'],
    top: ['stock exchange', 'bse', 'dalal'] },
  { id: 39, text: 'we wanna see the gateway of mumbai, is it close to where we are going?', ctx: 'ngma', want: ['find_stops', 'eta_from_here', 'reply'],
    top: ['gateway of india'] },
  { id: 40, text: 'wahan paas mein koi famous mandir hai kya jahan ja sakte hai?', ctx: 'ngma', want: ['find_stops'],
    check: g => is(fs(g), 'limit_type', 'near_destination'), // 'wahan paas' = near there
    top: ['mandir', 'temple', 'mumbadevi', 'siddhivinayak', 'babulnath'] },
  // User replay 2026-10-05 (Bandra -> Nehru Planetarium, car on the Sea Link). #41: keep the breadth, and Haji Ali
  // (~1.5 km past the route end) is found. #42: a question about the results keeps the cards (no new search).
  { id: 41, text: 'my friend was saying we should definetly consider visiting any nearby religious places', ctx: 'onlink',
    want: ['find_stops'], check: g => has(fs(g), 'need', 'religious'), top: ['haji ali'] },
  { id: 42, text: 'is it open for non muslims?', ctx: 'religious', want: ['reply', 'web_search', 'place_details'],
    check: (_, r) => r.steps.some(s => s.name === 'find_stops') ? 'searched again, the cards were replaced' : null },
  // Then a food search replaced the religious-places results, then "haji ali". v1 sent a stale r-ref. Any ref used must be Haji Ali's; no ref or promise in the reply.
  { id: 43, text: 'haji ali', ctx: 'hajiali', want: ['find_stops', 'place_details', 'eta_from_here', 'make_link', 'reply'],
    check: (_, r) => {
      const haji = Object.keys(r.trip.places).find(k => /haji ali/i.test(r.trip.places[k].name))
      const wrong = r.steps.map(s => s.args?.ref).filter(ref => ref && ref !== haji && ref !== 'destination')
      const named = r.steps.some(s => s.name === 'find_stops' && /haji/i.test(JSON.stringify(s.args)))
      return wrong.length ? `ref ${wrong} is not Haji Ali (${haji ?? 'not in trip'})`
        : REF_IN_TEXT.test(r.text) ? 'ref in the reply' : PROMISE.test(r.text) ? 'announced instead of acting'
        : haji || named ? null : 'Haji Ali neither looked up nor in the trip'
    } },
  // Sprint 2 (user test): a fact said inside a search was not saved; find_stops ended the turn first. Saved by
  // find_stops save (or a remember in the same round).
  { id: 44, text: 'dad is vegetarian, koi accha cafe', profile: [], want: ['find_stops'],
    check: g => /veg/i.test(fs(g).save ?? g('remember').note ?? '') ? null : 'the fact was not saved' },
  // Sprint 2: a brand + detour search escalated to the planning tier (~90 s). It must stay on the fast tier.
  { id: 45, text: "Something like Domino's, max 10 min detour", want: ['find_stops'],
    check: (g, r) => all(is(fs(g), 'limit_type', 'detour'), r.progress.some(s => /^Thinking/.test(s)) ? 'escalated to planning' : null) },
  // E2E run 2026-10-10 (#46-56, bus TESTSET.md).
  { id: 46, text: 'papa is fine now, find chai instead', ctx: 'delhi', want: ['find_stops'],
    check: (g, r) => all(has(fs(g), 'need', 'chai', 'tea'), nonLatin([r.text, ...r.names])) },
  // A follow-up that quotes a card: no raw field values or price enums in the reply, no refs ("3.5★, MODERATE, open now").
  { id: 47, text: 'what was the third option you showed first, and how pricey is it?', ctx: 'followup', want: ['reply', 'place_details', 'find_stops'],
    check: (_, r) => all(RAW_REPLY.test(r.text) ? `raw value in the reply: ${r.text.match(RAW_REPLY)![0]}` : null,
      REF_IN_TEXT.test(r.text) ? 'ref in the reply' : null) },
  // similar_to "none" must reach the search as absent (code normalises it; the model still writes it).
  { id: 48, text: 'something sweet near there, dad is still veg', ctx: 'followup', want: ['find_stops'],
    check: (g, r) => all(has(fs(g), 'need', 'sweet', 'dessert', 'mithai', 'ice cream', 'bakery', 'cake', 'halwai'),
      r.search?.args.similar_to && ABSENT.test(r.search.args.similar_to) ? `similar_to ${JSON.stringify(r.search.args.similar_to)} reached the search` : null) },
  // The cards' minutes are from the destination (near_destination): answer from them, never from eta_from_here (the car).
  { id: 49, text: 'which of these is closest to the gallery, and how many minutes from it?', ctx: 'ngmalist', want: ['reply'],
    check: (_, r) => {
      const mins = new Set(r.trip.searches.at(-1)!.candidates.map(c => c.min))
      const said = [...r.text.matchAll(/(\d+)\s*min/gi)].map(m => +m[1])
      // An eta_from_here on a card is answered from the search (code), so the call itself is fine; the minutes said are what count.
      return said.find(n => !mins.has(n)) != null ? `minutes ${said} are not the search's (${[...mins]})` : null
    } },
  // "What stops do we have?" reads the plan (trip.ahead), not the cards shown earlier (one stop planned; the other cards were dropped).
  { id: 52, text: 'what stops do we have now?', ctx: 'stops', want: ['reply', 'get_trip_state'],
    check: (_, r) => {
      const key = (ref: string) => r.trip.places[ref].name.toLowerCase().split(/[ ,|(-]+/)[0]
      const stop = key(r.trip.plan[0].ref), t = r.text.toLowerCase(), full = r.trip.places[r.trip.plan[0].ref].name.toLowerCase()
      // a dropped card's first word that also sits in the stop's own name ("... KURLA(W)") is not a mention of that card
      const dropped = cardRefs(r.trip).slice(1).map(key).filter(k => k !== stop && !full.includes(k) && t.includes(k))
      return !t.includes(stop) ? `the planned stop (${stop}) is not named` : dropped.length ? `names cards that are not in the plan: ${dropped}` : null
    } },
  // "Our flight is at 6": a deadline, not a departure (no depart_at); arrival = now + minutes ahead, or ask am / pm.
  { id: 53, text: 'our flight is at 6, will we make it?', want: ['reply', 'eta_from_here'],
    // depart_at = now is "leaving now" and fine; depart_at 06:00 / 18:00 is the flight time taken as a departure (the bug).
    check: (g, r) => /T(06|18):00/.test(g('eta_from_here').depart_at ?? '') ? `the flight time was used as a departure (${g('eta_from_here').depart_at})`
      : /\b(am|pm)\b|\d{1,2}:\d{2}/i.test(r.text) ? null : 'neither asks am / pm nor gives an arrival time' },
  // "haji ali" after a Haji Ali Juice Centre card: look up the dargah by name or ask which; never the juice card as the dargah.
  { id: 56, text: 'tell me more about haji ali', ctx: 'juice', want: ['find_stops', 'place_details', 'reply'],
    check: (_, r) => {
      const juice = Object.keys(r.trip.places).find(k => /juice/i.test(r.trip.places[k].name))
      if (!juice) return 'no juice-centre card in the context'
      const looked = r.steps.some(s => s.name === 'find_stops' && /dargah/i.test(JSON.stringify(s.args.places ?? s.args)))
      const asked = r.text.includes('?') && /dargah/i.test(r.text) && /juice/i.test(r.text)
      return r.steps.some(s => s.args?.ref === juice) && !looked && !asked ? 'took the juice-centre card for the dargah' : null
    } },
  // A note deleted by the user stays deleted: only the profile in the context counts, not what old chat quoted.
  { id: 54, text: 'what do you know about my family?', ctx: 'stale', profile: [{ id: 'n5', text: 'Mom likes strong tea' }], want: ['reply'],
    check: (_, r) => /spic/i.test(r.text) ? 'a deleted note came back (spicy)' : /tea|mom/i.test(r.text) ? null : 'the profile note is not used' },
  // The profile is in the context: the answer uses it, not "I don't recall". A get_trip_state first is a wasted call: it shows in the steps line, it does not fail the case.
  { id: 55, text: 'what do you remember about mom?', profile: [{ id: 'n6', text: 'Mom eats onion now' }], want: ['reply'],
    check: (_, r) => /onion/i.test(r.text) && !/(don.?t|do not) (recall|remember|know)/i.test(r.text) ? null : 'the profile note is not used' },
  // Safety text first (from code: everyone out and away, bonnet closed, 112), then the mechanic search in the same turn.
  { id: 50, text: 'car is smoking from the bonnet', want: ['find_stops'],
    check: (g, r) => all(has(fs(g), 'need', 'mechanic', 'car', 'repair', 'garage', 'service'),
      PROMISE.test(r.text) ? 'announced instead of acting' : null,
      /112/.test(r.text) && /bonnet|hood/i.test(r.text) && /\bout\b/i.test(r.text) ? null : 'no safety text (out, bonnet, 112)') },
  // A toddler is on the ride (trip note). A washroom request: honest that cleanliness is unknown; not only public toilets.
  { id: 51, text: 'need a clean washroom', ctx: 'toddler', want: ['find_stops'],
    check: (_, r) => {
      const said = [r.text, ...(r.search?.picks.map(p => p.reason) ?? [])].join(' ')
      const unknown = /(can.?t|cannot|unable|not|isn.?t|no way to) (confirm|tell|verify|say|know|sure|listed|shown|available)|unknown|no (info|data|details)|don.?t know/i.test(said)
      const toilets = r.names.filter(n => /toilet|washroom|restroom|sulabh|sbm|shauchalay|urinal/i.test(n)).length
      return !unknown ? 'does not say cleanliness is unknown' : toilets && toilets === r.names.length ? 'only public toilets for a toddler' : null
    } },
  // Who is on this ride is a trip note, never the profile (DECISIONS 2026-10-10). Numbered 57 here; the lead numbers it in TESTSET.md.
  { id: 57, text: 'remember we have a toddler with us', want: ['remember', 'find_stops'],
    check: (_, r) => r.memory.add.length && r.memory.add.every(n => n.scope === 'trip') ? null : `saved as ${JSON.stringify(r.memory.add.map(n => n.scope))}, wanted trip` },
  // F8 2's request: tomorrow's 19:00, and no talk about the prompt ("no extra claim added"). Numbered 58 here.
  { id: 58, text: 'we leave at 7 pm tomorrow, will traffic be bad?', want: ['eta_from_here', 'reply'],
    check: (_, r) => META.test(r.text) ? `talks about the prompt: ${r.text.match(META)![0]}` : /tomorrow|kal/i.test(r.text) ? null : 'does not say tomorrow' },
  // Daylight E2E run 2026-10-10 17:56 IST (#59-70, bus TESTSET.md). Every case also fails on a repeated provider call (#64).
  // #59: notes are wishes, not facts about a candidate: no reason holds "26/11" / "attack" unless the place's name does.
  { id: 59, text: "26/11 attack sites near where we're going", ctx: 'ngma', want: ['find_stops'],
    top: ['taj', 'leopold', 'terminus', 'oberoi', 'cama', 'trident', 'nariman'],
    check: (_, r) => {
      const bad = r.search?.picks.map(p => ({ name: r.search && r.names[r.search.picks.indexOf(p)], reason: p.reason }))
        .find(p => /26\/11|attack/i.test(p.reason) && !/26|attack/i.test(p.name ?? ''))
      return bad ? `reason states the topic as a fact: ${bad.name}: ${JSON.stringify(bad.reason)}` : null
    } },
  // #65: where the car is is a road, not the trip's origin: the reply names the current or next road, never "starting from".
  { id: 65, text: 'where are we, which road next?', ctx: 'moved', want: ['reply', 'get_trip_state'],
    check: (_, r) => {
      const plain = /^(head|turn|left|right|slight|sharp|onto|toward|towards|continue|straight|merge|keep|take|exit|ramp|then|the|and|road|stay)$/i
      const words = nextSteps(r.trip).slice(0, 2).flatMap(s => s.text.match(/[A-Za-z]{3,}/g) ?? []).filter(w => !plain.test(w))
      return /start(ing|ed) (from|at)/i.test(r.text) ? 'says it is starting from the origin'
        : words.some(w => r.text.toLowerCase().includes(w.toLowerCase())) ? null : `names none of the current / next road (${words.slice(0, 6)})`
    } },
  // #67: the nearest hospital first; "general" only where the name says so.
  { id: 67, text: 'accident ho gaya, papa ko chot lagi hai', ctx: 'delhi', want: ['find_stops'],
    check: (g, r) => {
      const cs = r.search?.candidates ?? [], first = cs.find(c => c.ref === r.search?.picks[0]?.ref)
      const general = r.search?.picks.map((p, i) => ({ name: r.names[i], reason: p.reason })).find(p => /\bgeneral\b/i.test(p.reason) && !/general/i.test(p.name))
      return all(has(fs(g), 'need', 'hospital'), general ? `"general" in a reason for ${general.name}` : null,
        first && first.min - Math.min(...cs.map(c => c.min)) > 5 ? `first card is ${first.min} min, nearest is ${Math.min(...cs.map(c => c.min))}` : null)
    } },
  // A place that is not in the trip yet: its buttons must not belong to another place (the ref guard holds the first call back).
  { id: 60, text: 'send Leopold to the family', ctx: 'ngmalist', want: ['find_stops', 'make_link', 'web_search', 'place_details', 'reply'],
    check: (_, r) => {
      const name = (ref: string) => r.trip.places[ref === 'destination' ? 'p2' : ref]?.name
      const wrong = r.steps.filter(s => ['place_details', 'eta_from_here', 'make_link'].includes(s.name)).map(s => name(s.args.ref))
        .filter(n => n && !/leopold/i.test(n))
      return wrong.length ? `ran on ${wrong.join(', ')}, not Leopold` : null
    } },
  // #61: a place-to-destination question after a near_destination list: the Gateway with its minutes from the gallery, the cards stay.
  { id: 61, text: 'how far is the Gateway of India from the gallery?', ctx: 'ngmalist', want: ['reply', 'eta_from_here'],
    check: (_, r) => {
      const gw = r.trip.searches.at(-1)!.candidates.find(c => /gateway/i.test(r.trip.places[c.ref].name))
      const said = [...r.text.matchAll(/(\d+)\s*min/gi)].map(m => +m[1])
      return !gw ? 'no Gateway card in the context' : r.steps.some(s => s.name === 'find_stops') ? 'searched again, the cards were replaced'
        : !/gateway/i.test(r.text) ? 'does not name the Gateway' : said.some(n => Math.abs(n - gw.min) <= 3) ? null : `minutes ${said} are not near ${gw.min}`
    } },
  // #62: "6 am" is the next 6 am in IST at any hour, never the arrival's own am / pm. Passes whenever the run happens.
  { id: 62, text: 'our flight is at 6 am, will we make it?', want: ['reply', 'eta_from_here'],
    check: (_, r) => {
      const spare = deadlineTimes('our flight is at 6 am')[0] - (Date.now() + ahead(r.trip).at(-1)!.min * 60_000)
      const no = /\b(miss|too late|too soon|too early|won.?t make|can.?t make|cannot make|not make it|leaves too)\b/i.test(r.text)
      return spare > 0 && no ? `says they miss it, with ${Math.round(spare / 60_000)} min to spare`
        : spare < 0 && !no && !/\blate\b/i.test(r.text) ? 'does not say they are late' : null
    } },
  // #63: the fix moved along the route, the stored route not refreshed: the reply and the trip bar (ahead) say the same minutes.
  { id: 63, text: 'how much longer till we reach the destination?', ctx: 'moved', want: ['reply', 'eta_from_here'],
    check: (_, r) => {
      const bar = ahead(r.trip)[0].min, said = [...r.text.matchAll(/(\d+)\s*min/gi)].map(m => +m[1])
      return said.some(n => Math.abs(n - bar) <= 3) ? null : `minutes ${said} vs the trip bar ${bar}`
    } },
  { id: 64, text: 'send it to the family', ctx: 'followup', want: ['make_link', 'reply'] },
]
// Every search: reasons in plain words, no field names or raw values ("serves_veg true, cafe type"; Sprint 2).
const RAW = /\b\w+_\w+\b|\b(true|false|null)\b/i

const only = process.argv[2]?.split(',').map(Number)
const cases = only ? CASES.filter(c => only.includes(c.id)) : CASES
const tally = new Map<number, number>(), runs = new Map<number, number>()
const show = (s: Step) => `${s.name}${s.name === 'reply' ? '' : JSON.stringify(s.args)}`

// A v2 trip as Start makes it (places sit where Google's route starts and ends). Free text routes here (test only).
async function tripTo(from: string, to: string): Promise<Trip> {
  const [leg] = await g.route(from, [to])
  const pts = decode(leg.polyline)
  const place = (name: string, location = pts[0]): Place => ({ place_id: null, name, location })
  return { ...newTrip(place(from), place(to, pts.at(-1)!), leg), live: false }
}

// A real search stored the way the tool runner stores it; the first 3 candidates stand in for the ranker's picks.
async function searched(t: Trip, asked: string, args: FindStopsArgs, answer: string): Promise<Trip> {
  const found = await findStops(g, { fix: t.fix, ahead: routeAhead(t) }, args)
  const { places, refs } = upsertPlaces(t.places, found.map(({ min, detour_min, from_dest, asked_for, ...p }) => p))
  const candidates = found.map((f, i) => ({ ref: refs[i], min: f.min, ...(f.detour_min != null && { detour_min: f.detour_min }),
    ...(f.from_dest && { from_dest: f.from_dest }), ...(f.asked_for && { asked_for: f.asked_for }) }))
  const id = `s${t.searches.length + 1}`
  const msgs: Message[] = [{ role: 'user', text: asked }, { role: 'assistant', text: answer, search: id }]
  return { ...t, places, messages: [...t.messages, ...msgs], searches: [...t.searches, { id, at: istIso(), from: t.fix, asked, args,
    candidates, picks: candidates.slice(0, 3).map(c => ({ ref: c.ref, reason: '' })), say: answer }] }
}

// Context trips are built on first use only, so a run of a few ids pays only for what they need.
const once = <T,>(f: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= f()) }

async function runRoute([from, to]: string[], first: boolean) {
  const base = once(() => tripTo(from, to))
  const trips: Record<string, () => Promise<Trip | null>> = {
    base,
    // Follow-ups: two real earlier searches on this route (pizza, then veg); the cards are the latest.
    followup: once(async () => searched(await searched(await base(), 'Find pizza places within 20 min',
      { need: 'pizza', limit_type: 'from_now', limit_min: 20 }, 'Here are pizza places.'),
      'Anything veg instead?', { need: 'vegetarian restaurant', limit_type: 'from_now', limit_min: 15 }, 'Here are veg places.')),
    // No destination (G2): a live trip at the route start, empty plan, no route.
    notrip: once(async () => newTrip({ place_id: null, name: 'Current location', location: (await base()).fix })),
    trishna: once(() => tripTo(from, 'Trishna, Kala Ghoda, Mumbai')), // #24 needs a trip that really goes there
    ngma: once(() => tripTo(from, 'National Gallery of Modern Art, Kala Ghoda, Fort, Mumbai')),
    // #46: F4's trip in Delhi after an emergency exchange (names there came back in Devanagari). Runs on every route.
    delhi: once(async () => ({
      ...await tripTo('Connaught Place, New Delhi', 'Indira Gandhi International Airport Terminal 3, New Delhi'),
      messages: [{ role: 'user', text: 'Accident, dad is hurt' }, { role: 'assistant', text: 'Call 112 now. The nearest hospitals are below.', sos: true }],
    })),
    // #49: the gallery trip after a near_destination search (its minutes are from the destination).
    ngmalist: once(async () => searched((await trips.ngma())!, 'places to see near the gallery',
      { need: 'tourist attraction', limit_type: 'near_destination', limit_min: 15 }, 'Here are places near the gallery.')),
    // #52: a plan with one stop (the first ATM card); the other cards were shown but are not in the plan.
    stops: once(async () => {
      const t = await searched(await base(), 'ATM on the way', { need: 'ATM', limit_type: 'from_now', limit_min: 15 }, 'Here are ATMs.')
      const stop = cardRefs(t)[0]
      const legs = await g.route(t.fix, [t.places[stop].location, t.places.p2.location])
      return { ...t, plan: [{ ref: stop, kind: 'stop' as const, reached_at: null }, { ref: 'p2', kind: 'destination' as const, reached_at: null }],
        route: legs.map((l, i) => ({ to: i ? 'p2' : stop, ...l })) }
    }),
    // #63: the car 40% along the route; the stored route is Google's, from the start (as the app has it between refreshes).
    moved: once(async () => {
      const t = await base()
      return { ...t, fix: { ...decode(cut(t.route![0].polyline, 0.4)).at(-1)!, t: istIso() } }
    }),
    // #51: a toddler is on the ride (a trip note).
    toddler: once(async () => ({ ...await base(), notes: [{ id: 'n7', text: 'We have a toddler with us' }] })),
    // #56: after religious places, a drink search that shows a Haji Ali Juice Centre card (named, so it is always there).
    juice: once(async () => {
      const t = await trips.religious()
      return t && searched(t, 'something cold to drink?', { need: 'juice', places: ['Haji Ali Juice Centre'], limit_type: 'from_now', limit_min: 15 }, 'Here are cold drinks.')
    }),
    // #54 = F7 7: a note about dad was quoted in chat, still inside the last 10 messages, and was then deleted on the Profile
    // screen (the app adds the "Forgot:" line, step 5). Only the profile note about mom is left.
    stale: once(async () => ({ ...await base(), messages: [
      { role: 'user' as const, text: 'dad avoids spicy food, find a veg place' }, { role: 'assistant' as const, text: 'Noted that dad avoids spicy food. Here are veg places.' },
      ...[0, 1].flatMap(i => [{ role: 'user' as const, text: `ok ${i}` }, { role: 'assistant' as const, text: 'Sure.' }]),
      { role: 'assistant' as const, text: 'Forgot: Dad avoids spicy food' }] })),
    // #41-43: the user's replay trip, the car on the Sea Link (onlink); religious places searched (religious); then
    // food (hajiali). Their own trip: run once, not per route.
    onlink: once(async () => {
      if (!first) return null
      const t = await tripTo('Benne, Bandra West, Mumbai', 'Nehru Planetarium, Worli, Mumbai')
      const onLink = decode(cut(t.route![0].polyline, 0.45)).at(-1)!
      return { ...t, fix: { ...onLink, t: istIso() } }
    }),
    religious: once(async () => {
      const t = await trips.onlink()
      return t && searched(t, 'my friend was saying we should definetly consider visiting any nearby religious places',
        { need: 'religious places', limit_type: 'near_destination', limit_min: 15 }, 'Here are religious places near the planetarium.')
    }),
    hajiali: once(async () => {
      const t = await trips.religious()
      return t && searched(t, 'something to eat on the way?', { need: 'restaurant', limit_type: 'from_now', limit_min: 15 }, 'Here are places to eat.')
    }),
  }
  const lines: string[] = [`\n##### ${from} -> ${to}`]

  for (const c of cases) {
    const t = await trips[c.ctx ?? 'base']()
    if (!t) continue
    runs.set(c.id, (runs.get(c.id) ?? 0) + 1)
    api.session = crypto.randomUUID() // each request is its own user for the proxy's per-session cap
    const started = Date.now()
    const progress: string[] = []
    // Provider calls this turn, counted here: a place_details / eta repeated with the same target costs money (#64).
    const seen = new Set<string>(), repeats: string[] = []
    const once1 = (k: string) => { if (seen.has(k)) repeats.push(k); seen.add(k) }
    const counted: MapProvider = { ...g, details: id => (once1('details ' + id), g.details(id)),
      eta: (f, to, at) => (once1(`eta ${to.lat},${to.lng} ${at ?? 'now'}`), g.eta(f, to, at)) }
    const a = await ask(counted, t, c.text, s => progress.push(s), c.profile ?? PROFILE)
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    const picks = a.search?.picks.map(p => a.places![p.ref]) ?? []
    const shown = picks.map(p => p.name.toLowerCase())
    const raw = a.search?.picks.find(p => RAW.test(p.reason))
    const get: Get = name => a.steps.find(s => s.name === name)?.args ?? {}
    const names = a.steps.map(s => s.name)
    const problem = repeats.length ? `provider call repeated in one turn: ${repeats.join(', ')}`
      : !names.some(n => c.want.includes(n)) ? `no ${c.want.join('|')} in: ${names.join(' > ') || 'nothing'}`
      : c.needs?.find(n => !names.includes(n)) ? `missing step ${c.needs.find(n => !names.includes(n))}`
      : c.check?.(get, { text: a.text, steps: a.steps, trip: t, progress, search: a.search, names: picks.map(p => p.name), memory: a.memory }) ?? (names.includes('find_stops') && !picks.length ? 'searched but showed nothing'
        : c.top && !shown.some(n => c.top!.some(w => n.includes(w))) ? `shown places miss ${c.top.join('|')}`
        : raw ? `raw field in a reason: ${JSON.stringify(raw.reason)}` : null)
    if (!problem) tally.set(c.id, (tally.get(c.id) ?? 0) + 1)
    let line = `${problem ? 'FAIL' : 'pass'} #${c.id} ${secs}s ${a.steps.map(show).join(' > ')}`
    if (a.skipped?.length) line += `  [held: ${a.skipped.map(show).join(', ')}]`
    if (problem) line += `\n       -> ${problem}`
    if (a.search) line += `\n       e2e: ${a.search.candidates.length} found; top: ${a.search.picks.map(p => {
      const cd = a.search!.candidates.find(x => x.ref === p.ref)!, pl = a.places![p.ref]
      return `${p.ref} ${pl.name} (${cd.min}m${cd.detour_min != null ? ` +${cd.detour_min}` : ''}, ${pl.rating ?? '-'}★/${pl.reviews ?? 0})`
    }).join(' | ')}`
    if (a.text) line += `\n       says: ${JSON.stringify(a.text.slice(0, 150))}`
    lines.push(line)
  }
  return lines.join('\n')
}

const out = await Promise.all(ROUTES.map((r, i) => runRoute(r, i === 0)))
console.log(out.join('\n'))
console.log('\n===== Pass rate per request')
console.log(cases.map(c => `#${c.id} ${tally.get(c.id) ?? 0}/${runs.get(c.id) ?? 0}`).join('  '))
console.log(`Total ${[...tally.values()].reduce((a, b) => a + b, 0)}/${[...runs.values()].reduce((a, b) => a + b, 0)}`)
console.log(`Calls: model ${calls.super + calls.ultra} (super ${calls.super}, ultra ${calls.ultra}), maps ${calls.maps}, search ${calls.search}`)

