// The ten flows of bus E2E.md as data. A step = what it says, how to do it (lib.ts helpers), its code checks (c: pass or
// fail in the script) and its judge note (j: for the reviewer, who reads the saved bundle). The checks every step gets
// (no console errors, no refs or announced work in replies, no raw values, Latin names, distinct card titles, a fast
// answer) live in run.ts. Places are picked by exact suggestion text (lib.ts Pick), so every run makes the same trip.
// F1 and F10 (2026-10-08) and F1, F5, F7 (2026-10-10, T2) have been run; the others are written from the spec.
import { ahead, decode, km, nextSteps, type Trip } from '@trippy/core'
import { addStop, along, answered, back, clockGap, clockIn, confirm, endTrip, events, gps, imHere, istClock, istNow, latest,
  linkProblem, minutesIn, offBy, openSheet, profile, read, reload, removeStop, replay, say, send, short, skip, start, startHere, tapBanner,
  unreached, until, used, whereNext, type Check, type Flow, type Step, type View } from './lib.ts'

const kinds = (t: Trip) => t.plan.map(e => e.kind).join()
const route0 = (t: Trip) => decode(t.route![0].polyline)[0]
const hrefs = (v: View) => v.f.page.locator('.links a').evaluateAll(a => a.map(x => x.getAttribute('href')!))
const noted = (v: View, re: RegExp) => [...v.profile, ...v.trip!.notes].some(n => re.test(n.text)) || JSON.stringify([v.profile, v.trip!.notes])
const sosShown = (v: View) => v.f.page.locator('a.sos').isVisible()
const search = (n: string): Check => [`search ${n}`, v => v.trip!.searches.at(-1)?.id === n || v.trip!.searches.length]
const ask = (say: string, j?: string, c?: Check[]): Step => ({ say, run: (f) => send(f, say), j, c })
const FAR = { lat: 17.4399, lng: 78.4983 } // Secunderabad, ~9 km from Charminar
const IST_TOMORROW = () => new Date(Date.now() + 5.5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10)

// --- Reading what the model said and did this step ---

const said = (v: View) => v.added.filter(m => m.role === 'assistant').map(m => m.text).join(' ')
const stepsOf = (v: View): { name: string; args: any }[] => v.log.filter(e => e.type === 'answer').flatMap(e => e.data.steps ?? [])
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '')
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const nameOf = (t: Trip, ref: string) => t.places[ref]?.name ?? ''
// Words that identify a place in a reply: its name's words of 5+ letters, else its first word.
const keys = (name: string) => {
  const w = plain(short(name)).split(/\s+/).filter(Boolean)
  return w.filter(x => x.length >= 5).length ? w.filter(x => x.length >= 5) : w.slice(0, 1)
}

// The reply states minutes and one is within 3 of a wanted number (the trip bar, a card). must = false: a reply
// that names no minutes at all is fine.
function minutesLike(v: View, want: number[], must = true): unknown {
  const got = minutesIn(said(v))
  if (!want.length) return skip('no minutes to compare with')
  if (!got.length) return must ? 'the reply states no minutes' : skip('the reply states no minutes')
  return got.some(g => want.some(w => Math.abs(g - w) <= 3)) || `reply says ${got.join(', ')} min; expected about ${want.join(' or ')}`
}
// The newest near_destination search (its minutes are from the destination), optionally one that holds a place named `of`.
const fromDest = (t: Trip, of?: RegExp) => [...t.searches].reverse().find(s =>
  s.args.limit_type === 'near_destination' && (!of || s.candidates.some(c => of.test(nameOf(t, c.ref)))))
// A reply about the minutes on the trip bar.
const barMinutes = (v: View, must = true) => minutesLike(v, ahead(v.trip!).map(a => a.min), must)

// Haji Ali Dargah, not "Haji Ali Juice Centre" (TESTSET #56).
const dargah = (name?: string) => !!name && /haji ali/i.test(name) && /dargah|durgah/i.test(name)

// The link buttons this step added point at the place asked about (#60: "Open in Maps" went to Sassoon Dock Clock Tower
// while the message said Leopold). `want` is a ref or a name pattern; the hrefs are read, never clicked.
async function linksTo(v: View, want: string | RegExp): Promise<unknown> {
  const hrefs = await v.f.page.locator('.links').last().locator('a').evaluateAll(a => a.map(x => x.getAttribute('href')!))
  return linkProblem(v.trip!, v.added, want, hrefs) || true
}
// A banner left on screen states the trip's current total (#66: a long-ETA banner outlived the leg it was about) and
// is gone once everything is reached. The "Arrived" banner is fine. Both banner kinds put the total in minutes.
async function bannerCurrent(v: View): Promise<unknown> {
  const a = ahead(v.trip!).at(-1)
  const stale = (await v.f.page.locator('.banner p').allTextContents()).filter(t => !/^Arrived/.test(t))
    .filter(t => !a || !minutesIn(t).some(m => Math.abs(m - a.min) <= 3))
  return !stale.length || { banner: stale, total_min: a?.min ?? 'arrived' }
}

const F1: Flow = {
  id: 'F1', title: "Mumbai: the demo, start to finish (Kurla West -> Domino's, Juhu Beach)",
  steps: [
    { say: "Start Kurla West -> Domino's, Juhu Beach",
      run: f => start(f, ['Kurla West', 'Kurla West', /^Mumbai/], ["Domino's Juhu Beach", "Domino's Pizza | Santacruz (West), Mumbai", /Juhu Tara Road/]),
      c: [['route drawn', v => !!v.trip!.route?.length], ['ahead > 0', v => ahead(v.trip!).at(-1)!.min > 0]],
      j: 'Long-ETA banner shown if the trip is >= 30 min (see the screen text).' },
    ask("dad is vegetarian, something like Domino's within 15 min", 'Veg-friendly picks with plain reasons.', [
      ['3 cards', v => latest(v.trip!).length === 3 || latest(v.trip!).length],
      ['profile note about veg', v => noted(v, /veg/i)],
      search('s1')]),
    ask('is the second one pure veg?', 'Answers about card 2 of s1 by name, not card 1 or 3.'),
    { say: 'Add stop on card 1 -> preview -> Confirm', run: async f => { const plus = await addStop(f, 0); await confirm(f); return plus },
      c: [['"+N min" shown before Confirm', v => /\+\d+ min/.test(v.out) || v.out],
        ['plan = [stop, destination]', v => kinds(v.trip!) === 'stop,destination' || kinds(v.trip!)],
        ['the stop is card 1 of s1', v => v.trip!.plan[0].ref === v.trip!.searches[0].picks[0].ref],
        ['2 route legs', v => v.trip!.route!.length === 2],
        ['card shows Added', v => v.f.page.locator('.add.added').count().then(n => n > 0)]] },
    { say: 'Replay until the stop is reached', run: async f => { await replay(f, t => t.plan[0].reached_at, 'the stop to be reached'); await openSheet(f) },
      c: [['stop reached_at set', v => !!v.trip!.plan[0].reached_at],
        ['✓ in the plan sheet', async v => (await v.f.page.locator('.plan li.stop .mark').first().textContent()) === '✓'],
        ['route not replaced on reaching', v => JSON.stringify(v.trip!.route) === JSON.stringify(v.before.trip!.route)]] },
    ask('how long till Juhu now?', undefined, [['reply minutes match the trip bar (within 3)', v => barMinutes(v)]]),
    ask('what was the third option you showed first?', "Names card 3 of s1 correctly (searches[0].picks[2])."),
    { say: 'Replay to arrival', run: f => replay(f, t => t.plan.every(e => e.kind !== 'destination' || e.reached_at), 'arrival'),
      c: [['Arrived banner', v => v.f.page.locator('.banner', { hasText: 'Arrived' }).isVisible()],
        ['every destination reached', v => v.trip!.plan.filter(e => e.kind === 'destination').every(e => e.reached_at)],
        ['no banner but "Arrived" (#66)', bannerCurrent]] },
    { say: 'Where next -> Juhu Beach', run: f => whereNext(f, ['Juhu Beach', 'Juhu Beach', /Mumbai/]),
      c: [['destination appended', v => v.trip!.plan.length === v.before.trip!.plan.length + 1 && v.trip!.plan.at(-1)!.kind === 'destination'],
        ['a new leg', v => v.trip!.route!.at(-1)!.to === v.trip!.plan.at(-1)!.ref],
        ['chat and s1 kept', v => v.trip!.messages.length >= v.before.trip!.messages.length && v.trip!.searches[0]?.id === 's1']] },
    ask('something sweet near there, dad is still veg', 'Veg respected without being told again in this turn.', [
      ['near_destination or from_now', v => ['near_destination', 'from_now'].includes(v.trip!.searches.at(-1)!.args.limit_type) || v.trip!.searches.at(-1)!.args]]),
  ],
}

const F2: Flow = {
  id: 'F2', title: 'Mumbai: refs that stay right over time (Benne, Bandra -> Nehru Planetarium)',
  steps: [
    { say: 'Start; replay until about 8 min are left',
      run: async f => { await start(f, ['Benne', 'Benne - Heritage Bangalore Dosa', /Bandra West/], ['Nehru Planetarium', 'Nehru Planetarium', /Worli/]); await replay(f, t => ahead(t).at(-1)!.min <= 8, '8 min left') } },
    ask('my friend says we should visit nearby religious places', 'Mixed kinds of places.', [
      ['need not narrowed to one religion', v => !/^(temples?|mosques?|churches|dargahs?)$/i.test(v.trip!.searches.at(-1)!.args.need) || v.trip!.searches.at(-1)!.args.need],
      // The dargah is closed at night and from_now drops closed places (#41), so this only holds in daylight.
      ['Haji Ali Dargah among the results (07:00-21:00 IST only)', v => {
        const h = istClock(Date.now()) / 60
        if (h < 7 || h >= 21) return skip(`run at ${istNow()}: the dargah may be closed`)
        const t = v.trip!, s = t.searches.at(-1)!
        return s.candidates.some(c => dargah(nameOf(t, c.ref))) || s.candidates.map(c => nameOf(t, c.ref))
      }]]),
    ask('is it open for non muslims?', undefined, [
      ['pins and cards stay', async v => v.trip!.messages.findLast(m => m.search)!.search === v.before.trip!.messages.findLast(m => m.search)!.search && await v.f.page.locator('.card.live').count() > 0]]),
    ask('food spots nearby?', undefined, [search('s2'), ['pins switch to s2', v => v.trip!.messages.findLast(m => m.search)!.search === 's2']]),
    // The bare name after a food list is ambiguous on purpose (TESTSET #56: the card is "Haji Ali Juice Centre"): the
    // model must go to the dargah, or ask which one.
    ask('haji ali', 'Talks about the dargah, or asks which Haji Ali (the juice centre is also on the list). Not silently the juice centre.', [
      ['the dargah was looked up or used, or the reply asks which', v => {
        const t = v.trip!, s = stepsOf(v)
        const viaRef = s.some(x => dargah(nameOf(t, x.args?.ref)))
        const viaSearch = s.some(x => x.name === 'find_stops') && t.searches.length > v.before.trip!.searches.length &&
          t.searches.at(-1)!.candidates.some(c => dargah(nameOf(t, c.ref)))
        const asked = /\?/.test(said(v)) && /dargah/i.test(said(v))
        return viaRef || viaSearch || asked || `no step on the dargah; steps: ${s.map(x => `${x.name}(${x.args?.ref ?? ''})`).join(', ')}`
      }]]),
    ask('which temple did you show me first?', 'Names a temple from s1.'),
    { say: 'Reload the page', run: reload,
      c: [['same trip document', v => JSON.stringify([v.trip!.messages, v.trip!.plan, v.trip!.searches, v.trip!.notes, v.trip!.places]) ===
        JSON.stringify([v.before.trip!.messages, v.before.trip!.plan, v.before.trip!.searches, v.before.trip!.notes, v.before.trip!.places])],
        ['cards and pins back', v => v.f.page.locator('.card.live').count().then(n => n > 0)]] },
    ask('tell me more about the Haji Ali Dargah', 'About the dargah (hours, what it is), not the juice centre.', [
      ['place_details on the dargah', v => stepsOf(v).some(x => x.name === 'place_details' && dargah(nameOf(v.trip!, x.args?.ref))) ||
        `place_details on ${stepsOf(v).filter(x => x.name === 'place_details').map(x => nameOf(v.trip!, x.args?.ref)).join(', ') || 'nothing'}`]]),
  ],
}

const F3: Flow = {
  id: 'F3', title: 'Mumbai: a long planning chat (Bandra West -> National Gallery of Modern Art, Kala Ghoda)',
  steps: [
    { say: 'Start', run: f => start(f, ['Bandra West', 'Bandra West', /^Mumbai/], ['National Gallery of Modern Art', 'National Gallery of Modern Art', /Mumbai/]) },
    // A lasting fact, so that "profile kept" at End trip is not trivially true.
    ask('remember mom is allergic to peanuts', undefined, [['profile note saved', v => v.profile.some(n => /peanut/i.test(n.text)) || JSON.stringify(v.profile)]]),
    // #32 / #59: the shown places are 26/11 sites, and "26/11" in a reason needs support from the place's name (the
    // ranker once copied the user's phrase onto a museum as a fact).
    ask('26/11 attack sites near where we\'re going', 'Taj, Leopold, CST or similar; nothing invented.', [
      ['a 26/11 site among the results (Taj, Leopold, CST, Oberoi, Cama, Nariman)', v => {
        const t = v.trip!, s = t.searches.at(-1)
        if (!s) return 'no search ran'
        const names = s.candidates.map(c => nameOf(t, c.ref))
        return names.some(n => /taj|leopold|chhatrapati|terminus|\bcst\b|oberoi|trident|cama|nariman/i.test(n)) || names
      }],
      ['no reason says 26/11 for a place whose name does not', v => {
        const t = v.trip!, s = t.searches.at(-1)
        const bad = (s?.picks ?? []).filter(p => /26\s*[/-]\s*11|mumbai attacks?/i.test(p.reason) &&
          !/taj|leopold|chhatrapati|terminus|\bcst\b|oberoi|trident|cama|nariman|26\s*[/-]\s*11/i.test(nameOf(t, p.ref)))
        return !bad.length || bad.map(p => `${short(nameOf(t, p.ref))}: ${p.reason}`)
      }]]),
    ask('which of these is closest to the gallery?', 'Uses minutes from the destination.', [
      ['reply minutes match the search (from the destination)', v => {
        const s = fromDest(v.trip!)
        return s ? minutesLike(v, s.candidates.map(c => c.min)) : skip('no search measured from the destination')
      }]]),
    ask('remember: we need to be back home by 9 pm', undefined, [['a trip note saved', v => noted(v, /9/)]]),
    ask('is Leopold open now?'),
    ask('what should we order at Leopold?', undefined, [['web_search used', v => used(v, 'web_search')]]),
    ask('send Leopold to the family', undefined, [['3 link buttons', async v => (await hrefs(v)).length === 3],
      ['WhatsApp href set (wa.me on desktop)', async v => (await hrefs(v)).some(h => h.startsWith('https://wa.me/'))],
      ['the buttons are for Leopold (maps place id, Uber name)', v => linksTo(v, /leopold/i)]]),
    ask('how far is the Gateway of India from the gallery?', undefined, [
      ['no new search; the cards on screen are unchanged (#61)', v => v.trip!.searches.length === v.before.trip!.searches.length &&
        JSON.stringify(latest(v.trip!).map(c => [c.ref, c.min])) === JSON.stringify(latest(v.before.trip!).map(c => [c.ref, c.min])) ||
        { searches: [v.before.trip!.searches.length, v.trip!.searches.length], cards: latest(v.trip!).map(c => short(c.name)) }],
      ['reply minutes match the search (from the destination)', v => {
        const t = v.trip!, s = fromDest(t, /gateway of india/i)
        return s ? minutesLike(v, s.candidates.filter(c => /gateway of india/i.test(nameOf(t, c.ref))).map(c => c.min)) : skip('the Gateway is in no search measured from the destination')
      }]]),
    ask('what time did I say we need to be back?', '9 pm, from the note (the chat window no longer has it).'),
    ask('go back to the first list you showed', 'The 26/11 sites again.'),
    // The document is validated as it stood before this step (run.ts keeps the last trip document of a flow).
    { say: 'End trip', run: endTrip, c: [['landing screen', v => v.f.page.locator('input[aria-label="From"]').isVisible()],
      ['trip document deleted', v => !v.trip],
      ['profile kept', v => (v.before.profile.length > 0 && JSON.stringify(v.profile) === JSON.stringify(v.before.profile)) || { before: v.before.profile, after: v.profile }]] },
  ],
}

const F4: Flow = {
  id: 'F4', title: 'Delhi: emergency (Connaught Place -> IGI Airport Terminal 3)',
  steps: [
    { say: 'Start', run: f => start(f, ['Connaught Place', 'Connaught Place', /^New Delhi/], ['IGI Airport Terminal 3', 'IGI Airport Terminal 3', /^Delhi$/]) },
    { say: 'accident ho gaya, papa ko chot lagi hai', j: 'General hospitals first.',
      run: async (f, d) => { const n = await say(f, 'accident ho gaya, papa ko chot lagi hai'); await f.page.locator('a.sos').waitFor({ timeout: 5000 })
        const early = (await read(f)).trip!.messages.length === d.trip!.messages.length + 1; await answered(f, n); return early },
      c: [['112 button before the answer', v => v.out], ['hospital cards', v => latest(v.trip!).length > 0], ['message has the sos flag', v => v.trip!.messages.some(m => m.sos)]] },
    { say: 'Reload', run: reload, c: [['112 button still there', sosShown], ['cards back', v => v.f.page.locator('.card.live').count().then(n => n > 0)]] },
    ask('how far is the first hospital?', 'Minutes consistent with its card.'),
    ask('papa is fine now, find chai instead', undefined, [['a new search', v => v.trip!.searches.length > v.before.trip!.searches.length]]),
    ask('which hospital did you suggest earlier?', 'Names it.'),
  ],
}

const F5: Flow = {
  id: 'F5', title: 'Delhi: car trouble and who is on board (Karol Bagh -> Sector 18, Noida)',
  steps: [
    { say: 'Start', run: f => start(f, ['Karol Bagh', 'Karol Bagh', /New Delhi/], ['Sector 18', 'Sector 18', /Noida/]) },
    ask('tyre puncture ho gaya', 'Puncture / tyre shops, not hospitals.', [['no 112 button', async v => !(await sosShown(v))]]),
    ask('car is smoking from the bonnet', 'Safety steps first, then help.', [['112 button', sosShown],
      ['a mechanic search ran in the same turn', v => (used(v, 'find_stops') && v.trip!.searches.length > v.before.trip!.searches.length) ||
        `steps: ${stepsOf(v).map(x => x.name).join(', ')}`]]),
    ask('remember we have a toddler with us', undefined, [
      ['a trip note saved, not a profile note', v => (v.trip!.notes.some(n => /toddler/i.test(n.text)) && !v.profile.some(n => /toddler/i.test(n.text))) ||
        { trip: v.trip!.notes, profile: v.profile }]]),
    ask('need a clean washroom', 'Honest that cleanliness is unknown; the toddler is considered.'),
    ask('who is travelling with us?', 'The toddler, from notes.'),
  ],
}

// F6 5 removes stop A; step 6 needs its name.
let removedStop = ''

const F6: Flow = {
  id: 'F6', title: 'Bengaluru: the plan as a data structure (MG Road -> Kempegowda International Airport)',
  steps: [
    { say: 'Start', run: f => start(f, ['MG Road', 'MG Road', /Bengaluru/], ['Kempegowda International Airport', 'Kempegowda International Airport Bengaluru (BLR)', /Devanahalli/]),
      c: [['long-ETA banner', v => v.f.page.locator('.banner').isVisible()]] },
    // Open: the banner asks "Anything similar closer, within 20 min?", which makes no sense for an airport (B11, Sprint 3).
    // Only the fact that a search runs is checked; read the result as a note, not as a pass.
    { say: 'Tap the banner', run: tapBanner, c: [['a search runs from it', v => v.trip!.searches.length > 0]] },
    { say: 'Add stop A (card 1), Confirm', run: async f => { await addStop(f, 0); await confirm(f) } },
    { say: 'ATM on the way -> Add stop B, Confirm', run: async f => { await send(f, 'ATM on the way'); await addStop(f, 0); await confirm(f) },
      c: [['plan = [A, B, airport]', v => kinds(v.trip!) === 'stop,stop,destination' && v.trip!.plan[0].ref === v.before.trip!.plan[0].ref || kinds(v.trip!)],
        ['3 legs', v => v.trip!.route!.length === 3]] },
    { say: '✕ on A', run: (f, d) => { removedStop = nameOf(d.trip!, d.trip!.plan[0].ref); return removeStop(f, short(removedStop)) },
      c: [['plan = [B, airport]', v => kinds(v.trip!) === 'stop,destination'], ['2 legs', v => v.trip!.route!.length === 2],
        ['the airport has no ✕', async v => (await v.f.page.getByRole('button', { name: `Remove ${short(v.trip!.places[v.trip!.plan[1].ref].name)}` }).count()) === 0]] },
    ask('what stops do we have now?', 'B, then the airport; not A.', [
      ['names every stop ahead, and not the removed one', v => {
        const t = v.trip!, text = plain(said(v)), ahead_ = unreached(t)
        const missing = ahead_.filter(e => !keys(nameOf(t, e.ref)).some(k => text.includes(k))).map(e => short(nameOf(t, e.ref)))
        // A's words only count against the reply when no stop still in the plan shares them (two "HDFC Bank ATM").
        const kept = new Set(ahead_.flatMap(e => keys(nameOf(t, e.ref))))
        const gone = keys(removedStop).filter(k => !kept.has(k) && text.includes(k))
        return (!missing.length && !gone.length) || { missing, removed_but_named: gone }
      }]]),
    { say: 'Replay until B is reached', run: f => replay(f, t => t.plan[0].reached_at, 'B to be reached'),
      c: [['B reached_at', v => !!v.trip!.plan[0].reached_at], ['1 leg ahead', v => v.trip!.route!.filter(l => !v.trip!.plan.find(e => e.ref === l.to)!.reached_at).length === 1]] },
    // "6 am": the arrival time to compare is computable at any hour (E2E.md F6 8).
    ask('our flight is at 6 am, will we make it?', 'No invented traffic.', [
      ['a banner on screen states the current total (#66)', bannerCurrent],
      ['arrival time in the reply = now + minutes ahead (within 3 min)', v => {
        const a = ahead(v.trip!).at(-1)
        if (!a) return 'no route ahead'
        const want = istClock((v.log.findLast(e => e.type === 'answer')?.t ?? Date.now()) + a.min * 60_000)
        const got = clockIn(said(v))
        if (!got.length) return 'the reply states no time of day'
        return got.some(g => clockGap(g, want) <= 3) || `reply says ${got.map(hhmm).join(', ')}; now + ${a.min} min = ${hhmm(want)}`
      }]]),
  ],
}

const F7: Flow = {
  id: 'F7', title: 'Bengaluru: memory across turns and trips (Koramangala -> Indiranagar, then a second trip)',
  steps: [
    { say: 'Start', run: f => start(f, ['Koramangala', 'Koramangala', /Bengaluru/], ['Indiranagar', 'Indiranagar', /^Bengaluru/]) },
    ask('mom is Jain, veg thali jaldi', 'Jain / veg-friendly.', [['profile note via save', v => noted(v, /jain/i)]]),
    ask('remember dad hates spicy food', undefined, [['profile note', v => v.profile.some(n => /spic/i.test(n.text)) || JSON.stringify(v.profile)]]),
    ask('actually mom eats onion now, forget the Jain thing', undefined, [['Jain note removed', v => !v.profile.some(n => /jain/i.test(n.text)) || JSON.stringify(v.profile)],
      ['onion note added', v => noted(v, /onion/i)]]),
    { say: 'Profile screen', run: f => profile(f), c: [['notes listed match the profile record', v => JSON.stringify([...v.out].sort()) === JSON.stringify(v.profile.map(n => n.text).sort()) || v.out]] },
    { say: 'Delete "dad hates spicy" there', run: async f => { await f.page.getByRole('button', { name: /Delete ".*spic/i }).click(); await until(f, d => !d.profile.some(n => /spic/i.test(n.text)), 'the note to go') },
      c: [['removed from the record', v => !v.profile.some(n => /spic/i.test(n.text))]] },
    { ...ask('what do you know about my family?', 'Only the remaining notes.', [
        // Jain was forgotten in step 4 and spicy deleted in step 6: neither may come back from older chat messages (#54).
        ['no text of a deleted note (Jain, spicy)', v => !/jain|spic/i.test(said(v)) || said(v)]]),
      run: async f => { await back(f); await send(f, 'what do you know about my family?') } },
    { say: 'End trip; start Koramangala -> HSR Layout', run: async f => { await endTrip(f); await start(f, ['Koramangala', 'Koramangala', /Bengaluru/], ['HSR Layout', 'HSR Layout', /Bengaluru/]) },
      c: [['profile carried over', v => v.profile.some(n => /onion/i.test(n.text))], ['old trip notes gone', v => v.trip!.notes.length === 0]] },
    ask('what do you remember about mom?', 'The onion fact.', [
      ['the reply uses the profile note about mom', v => {
        const n = v.profile.find(n => /\bmom\b|mother/i.test(n.text))
        if (!n) return 'no note about mom in the profile'
        const text = plain(said(v)), words = plain(n.text).split(/\s+/).filter(w => w.length >= 5)
        return words.some(w => text.includes(w)) || `reply has none of: ${words.join(', ')}`
      }],
      ['no text of a deleted note (Jain, spicy)', v => !/jain|spic/i.test(said(v)) || said(v)]]),
  ],
}

const F8: Flow = {
  id: 'F8', title: 'Kolkata: later departure and opening hours (Howrah Station -> Victoria Memorial)',
  steps: [
    { say: 'Start', run: f => start(f, ['Howrah Station', 'Howrah Railway Station', /Howrah/], ['Victoria Memorial', 'Victoria Memorial', /Kolkata/]) },
    ask('we leave at 7 pm tomorrow, will traffic be bad?', 'Says tomorrow; no traffic claims beyond the numbers.', [
      ['eta_from_here with tomorrow 19:00 IST', v => v.log.some(e => e.type === 'answer' && e.data.steps?.some((s: any) =>
        s.name === 'eta_from_here' && String(s.args.depart_at).startsWith(`${IST_TOMORROW()}T19:00`)))]]),
    ask('will Victoria Memorial be open then?', 'Answers from the hours.', [['place_details on the destination', v => used(v, 'place_details')]]),
    ask('any good mishti doi place near Victoria Memorial?', undefined, [['near_destination search', v => v.trip!.searches.at(-1)!.args.limit_type === 'near_destination']]),
    ask('how long from there to Victoria Memorial?', 'Minutes from the destination.', [
      ['reply minutes match a card (from the destination)', v => {
        const s = fromDest(v.trip!)
        if (!s) return skip('no search measured from the destination')
        return minutesLike(v, s.picks.flatMap(p => s.candidates.filter(c => c.ref === p.ref).map(c => c.min)))
      }]]),
    ask("what did you say about tomorrow's traffic?", 'Repeats the earlier ETA.'),
  ],
}

const F9: Flow = {
  id: 'F9', title: 'Hyderabad: no destination, then one (fake GPS at Charminar)', geo: { lat: 17.3616, lng: 78.4747 }, phone: true,
  steps: [
    { say: 'Search around me', run: startHere, c: [['live trip', v => v.trip!.live], ['plan empty', v => v.trip!.plan.length === 0], ['route null', v => v.trip!.route === null]] },
    ask('famous biryani nearby', undefined, [['cards around the fix', v => latest(v.trip!).length > 0 && latest(v.trip!).every(p => km(p.location, v.trip!.fix) < 15)]]),
    ask('is the first one actually famous?', undefined, [['web_search used', v => used(v, 'web_search')]]),
    ask('send it to the family', undefined, [['link buttons', async v => (await hrefs(v)).length === 3],
      ['WhatsApp href is whatsapp:// on a phone', async v => (await hrefs(v)).some(h => h.startsWith('whatsapp://'))],
      ['the buttons are for the first card', v => linksTo(v, latest(v.trip!)[0].ref)]]),
    { say: 'Where next -> Golconda Fort', run: f => whereNext(f, ['Golconda Fort', 'Golconda Fort', /Khair Complex/]),
      c: [['destination in the plan', v => kinds(v.trip!) === 'destination'], ['route appears', v => !!v.trip!.route?.length]] },
    { say: 'Move fake GPS along the route', run: (f, d) => gps(f, along(d.trip!, 0.3), x => km(x.trip!.fix, along(d.trip!, 0.3)) < 0.05, 'the fix to follow'),
      c: [['minutes ahead go down', v => ahead(v.trip!)[0].min < ahead(v.before.trip!)[0].min]] },
    ask('how far is Golconda now?', 'Matches the trip bar.', [['reply minutes match the trip bar (within 3)', v => barMinutes(v)]]),
  ],
}

const F10: Flow = {
  id: 'F10', title: 'Hyderabad: the GPS rules (Charminar -> HITEC City)', geo: FAR,
  steps: [
    { say: 'Fake GPS ~9 km away; start from picked Charminar',
      run: async f => { await start(f, ['Charminar', 'Charminar', /Charminar Road/], ['HITEC City', 'HITEC City', /^Hyderabad/]); await openSheet(f)
        await until(f, async () => (await events(f)).some(e => e.type === 'position' && e.data.src === 'gps'), 'a GPS reading') },
      c: [['live false', v => !v.trip!.live], ["\"I'm here\" shown", v => v.f.page.getByRole('button', { name: /I'm here/ }).isVisible()],
        ['a GPS reading arrived', v => v.log.some(e => e.type === 'position' && e.data.src === 'gps' && km(e.data, FAR) < 0.1)],
        ['the fix stays at Charminar', v => km(v.trip!.fix, v.trip!.places[v.trip!.origin].location) < 0.01],
        ['the fake GPS is 8-10 km from Charminar', v => { const d = km(FAR, v.trip!.places[v.trip!.origin].location); return (d >= 8 && d <= 10) || `${d.toFixed(1)} km` }]] },
    { say: 'Move fake GPS within 1 km of Charminar',
      run: async (f, d) => { const o = d.trip!.places[d.trip!.origin].location, p = { lat: o.lat + 0.002, lng: o.lng }
        await gps(f, p, x => x.trip!.live && km(x.trip!.fix, p) < 0.05, 'live GPS to take over'); return p },
      c: [['live true', v => v.trip!.live], ['the fix follows GPS', v => km(v.trip!.fix, v.out) < 0.05]] },
    { say: 'Move along the route',
      run: async (f, d) => { const p = along(d.trip!, 0.25); await gps(f, p, x => km(x.trip!.fix, p) < 0.05, 'the fix to follow') },
      c: [['ahead goes down', v => ahead(v.trip!)[0].min < ahead(v.before.trip!)[0].min],
        ['next steps update', v => JSON.stringify(nextSteps(v.trip!)) !== JSON.stringify(nextSteps(v.before.trip!))]] },
    { say: 'Move ~500 m off the route and stay > 60 s',
      run: async (f, d) => { const t0 = Date.now(), old = JSON.stringify(d.trip!.route), p = offBy(d.trip!, along(d.trip!, 0.5))
        await gps(f, p, async x => (await events(f)).some(e => e.type === 'off_route' && e.t >= t0) && JSON.stringify(x.trip!.route) !== old, 'a new route after 60 s off the road', 240_000) },
      c: [['off_route in the log, then a routes call', v => { const o = v.log.find(e => e.type === 'off_route'); return !!o && v.log.some(e => e.type === 'call' && e.data.path === '/maps/routes' && e.t >= o.t) }],
        ['new route starts near the fix', v => km(route0(v.trip!), v.trip!.fix) < 0.5]] },
    // The reply may name no minutes at all; when it does they must match the bar.
    ask('where are we, which road next?', 'Uses the next steps.', [['minutes, if any, match the trip bar (within 3)', v => barMinutes(v, false)]]),
    { say: 'New trip with fake GPS far away; tap "I\'m here"',
      run: async f => { await endTrip(f); await f.ctx.setGeolocation({ latitude: FAR.lat, longitude: FAR.lng })
        await start(f, ['Charminar', 'Charminar', /Charminar Road/], ['HITEC City', 'HITEC City', /^Hyderabad/]); await imHere(f, FAR)
        await until(f, d => km(route0(d.trip!), FAR) < 0.6, 'a route from the fake GPS') },
      c: [['live true', v => v.trip!.live], ['route from the fake GPS', v => km(route0(v.trip!), FAR) < 0.6], ['the fix is the fake GPS', v => km(v.trip!.fix, FAR) < 0.05]] },
  ],
}

export const FLOWS = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10]
