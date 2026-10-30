import { chat, type CallType, type Msg, type ToolCall, type ToolChoice } from './llm.ts'
import { post } from './api.ts'
import { deadlineNote, deadlineOf, departTime, istIso, noteDeadline, type Deadline } from './time.ts'
import { TOOLS } from './tools.ts'
import { behind, findStops, type Found } from './find_stops.ts'
import { km } from './geo.ts'
import { ahead, buildContext, history, legsAhead, minutesSince, nextSteps, priceSymbol, routeAhead, searchView, stale, upsertPlaces, RUPEES } from './context.ts'
import type { MapProvider, Trip, Note, Place, Search, FindStopsArgs } from './types.ts'

export const SYSTEM = `You are Trippy, a passenger's co-pilot in India. Users write in English, Hindi or Hinglish; reply briefly in the same style.
Always act by calling a tool. Use reply for a direct answer. Never write that you will check something; call the tool instead.
Use find_stops to look up places. Never invent places: only mention places returned by tools or listed in the context (ahead, last_search, cards_shown_earlier).
"Similar" or "like X" means the same kind of place as X (or as the trip destination if X is not named): set need to that kind (e.g. pizza) and similar_to to X's name.
If the user changes a limit or wish for the same need (time, detour, price, rating), call find_stops again with it in limit or notes.
Medical emergency (someone hurt or unwell, accident with injury): call find_stops at once with need "hospital", from_now 15, notes "emergency". The app shows the 112 button.
Vehicle trouble is not a medical emergency: search the specific fix ("tyre puncture repair", "car mechanic"); if there is smoke or fire, reply first with brief safety steps.
The minutes in trip.ahead are for leaving right now only. Never guess traffic or travel times for any other time: for a later departure, always call eta_from_here with depart_at.
last_search minutes are from where the car was then, or from the destination when minutes_from says so (answer place-to-destination questions from them, not eta_from_here); minutes left out of a search are out of date: call eta_from_here before stating any time for those places.
Where to look: the plan or stops = trip.ahead (cards_shown_earlier is not the plan); facts about the people = notes and profile in the context only (older chat may quote deleted ones).
A lasting fact about the people said inside a search request (diet, allergy, "dad is vegetarian, koi cafe") goes in find_stops save, unless the context already has it.
If a new fact replaces a saved note, call forget on the old note id, then remember the new fact.
You cannot change or choose the route (Google computes it). For route or traffic-avoidance requests, reply honestly and offer stops instead.
You cannot add or remove stops: tell the user to tap Add stop on a card (or the cross on a planned stop).
If the user names a historical event, person or topic, also put up to 4 well-known sites tied to it in places (they are checked on Google). If the event they name does not fit the city, use the one they most likely mean and say so.
A place the user names that is not in the context, or that matches a card and a better-known place (haji ali after a juice-centre card): call find_stops with its full name in places, or ask which. Use a ref only for the place it belongs to.
A time given with flight, train or "by" is a deadline, not a departure: the app works it out (to the airport or station for a flight or train); reply with its verdict, say which airport or station it assumed, and ask am or pm if unclear.
Notes are for this trip. Use scope profile only when the user asks to keep it for future trips (always, every trip, next time, permanently).
If the user means one specific place you can name (a famous person's home, a landmark described in words), put its exact name in places, never in notes.
Never show refs (p1, p2) to the user; use place names.
Context (JSON):
`

const RANK = `You rank stops for a family in a car. Pick the best 3 candidates for the request, using only the candidates given and only facts in them. Weigh time, rating, review count, open now, and the notes. Notes are what the passengers wish, never facts about a candidate: a note like "26/11 sites" does not make a place one. For vegetarian needs prefer type vegetarian_restaurant or "pure veg" in the name, and say so in the reason. Candidates with asked_for were named for this request: prefer them unless clearly worse. behind_car means the car has already passed it: prefer places ahead. For emergencies the nearest hospital comes first, unless it is a clinic or a specialty centre (eye, dental, maternity, heart, cancer); call one "general" only if its name says so. For sights and places to visit, far more reviews means better known: prefer it over a slightly higher rating. Never claim anything the data does not show (clean, emergency services, pure veg, wait time, a link to an event or topic unless the name shows it). Washroom cleanliness is not in the data: say it is unknown in the reasons, and with small children in the notes prefer malls, petrol pumps and restaurants over public toilets. Reply with JSON only:
{"top": [{"ref": "p1", "reason": "one short line"}], "say": "one short sentence to the passengers"}
"reason" is why this one fits, in plain words a friend would say ("pure veg, and the best loved nearby"). The card already shows minutes, rating, reviews and price: do not list them, and never write field names or raw values (serves_veg, true, type).
"say" may use only names, minutes, ratings and open status from the data: no history, purpose or reputation claims.`

// Code keyword check (Q35): shows the 112 button at once, before any model call.
const EMERGENCY = /\b(accident|hurt|injur|bleed|unconscious|faint|heart attack|chest pain|fire|smok|crash|emergency|ambulance)/i
export const isEmergency = (text: string) => EMERGENCY.test(text)

export type Step = { name: string; args: any }
// remember / forget are the model's only way to change state (Q17); the caller applies these.
export type Memory = { add: (Note & { scope: 'trip' | 'profile' })[]; remove: string[] }
export type Links = { label: string; maps: string; uber: string; whatsapp: string; whatsapp_app: string }
// What a turn returns for the app to write (code writes all state): the reply, memory ops, and after a find_stops the
// trip's places with the new candidates merged in (refs assigned) plus the full search. link = a ref made into links.
// steps = the tool calls that ran; skipped = the ones the code held back or served from an identical earlier call (debug only).
// end = the model called end_trip: the app opens its End-trip confirm (the user still decides).
export type Answer = { text: string; steps: Step[]; skipped?: Step[]; memory: Memory; places?: Record<string, Place>; search?: Search; link?: string; end?: true }

const MAX_ROUNDS = 4
const ENDS_TURN = new Set(['find_stops', 'reply'])
// Shown only when a turn escalates to the planning tier. Ultra filled places only about half the time without it.
const PLAN_HINT = 'Planning question. In find_stops, put up to 4 specific, well-known places that fit the request in ' +
  'places (exact names as on Google Maps); keep need generic. Notes are only for ranking.'
// Announcing instead of acting (TESTSET #9, #32): "more info coming", "I'll look up", "let me check".
export const PROMISE = /\b((let me|i['’]?ll) (check|look|find|get|search|see|fetch|pull)|more info coming|one moment|hold on)\b/i
// An optional find_stops text the model fills with "none" instead of leaving out (TESTSET #48: 2 wasted Places calls).
export const ABSENT = /^\s*(none|null|n\/a|na|nil|-+)?\s*$/i
export const GAVE_UP = "Sorry, I couldn't find that. Could you ask another way, or name the place you mean?"
// The promise cut out of a reply, the rest kept: "…No public toilets within 15 min. …; let me get live ETA." was replaced whole by
// GAVE_UP (ride 2026-10-18, E). A sentence keeps what comes before its promise when that is 3+ words. '' = nothing useful left.
export const dropPromise = (text: string) => !PROMISE.test(text) ? text : text.split(/(?<=[.!?…])\s+|\n+/).map(s => {
  const m = s.match(PROMISE)
  if (!m) return s
  const before = s.slice(0, m.index).replace(/[\s,;:–—-]*(\b(and|so|but)\s*)?$/i, '')
  return before.split(/\s+/).length >= 3 ? before + '.' : ''
}).filter(Boolean).join(' ')
// find_stops save keeps only facts like these (diet, allergy, health, mobility); anything else is dropped.
export const LASTING = /\b(veg|non-?veg|vegan|jain|egg|allerg|diabet|halal|kosher|gluten|lactose|dairy|nut|peanut|seafood|fish|pork|beef|chicken|meat|spic|wheelchair|pregnan|walk|knee|elderly|baby|toddler|infant)/i
// Refs are never shown to users, but history lines carry them ("Options: p3 Si Nonna's") and replies copy them.
export const REF = /\(?\bp\d{1,3}\b\)?:? ?/g
// Raw provider values never reach the user (TESTSET #47: "3.5★, MODERATE, open now"). Price enums become ₹ by code;
// field names and ": true" send the reply back once.
export const RAW_VALUE = /\b[a-z]+_[a-z_]+\b|\b(null|undefined)\b|[:=]\s*(true|false)\b/
// Talk about the prompt itself ("based on Google's forecast - no extra claim added"): never shown (B16).
export const META = /\bno (extra|additional|other) claims?\b|\bsystem prompt\b|\bas instructed\b|\bper (my|the) instructions?\b/i
// A turn about a deadline said earlier ("will we still make it for the flight"): the saved deadline note answers it.
const MENTIONS = /\b(flight|train|airport|station|deadline|make it(?! to)|on time|in time)\b/i
// Who is on this ride is a trip note, not a lasting fact about a person (DECISIONS 2026-10-10, TESTSET #51).
export const ON_RIDE = /\b(with us|on board|along with us|travell?ing with)\b/i
// Notes are for this trip; the profile only when the user's own words ask to keep it (decided 2026-10-21, ride item 6: "dad is
// diabetic" went to the profile unasked). Code checks the user's words, not the model's scope, both ways: "Always remember that
// dad is diabetic" was saved for the trip when the model asked `trip` (demo recording, 2026-10-30).
export const FOREVER = /\b(always|every (trip|time|ride|journey)|all (my |our )?(trips|rides)|future trips?|next time|permanent(ly)?|for good|forever|hamesha|har baar)\b/i
const scopeOf = (said: string, note: string) => FOREVER.test(said) && !ON_RIDE.test(note) ? 'profile' as const : 'trip' as const
// Vehicle smoke or fire (TESTSET #50): the safety text comes from code, then the model searches a mechanic in the same turn.
export const isVehicleFire = (text: string) => /\b(smok\w*|fire|flames?|burning|dhua\w*)\b/i.test(text) &&
  /\b(car|gaadi|gadi|bonnet|hood|engine|vehicle|bike|taxi|cab)\b/i.test(text)
export const SAFETY = 'Get everyone out and well away from the car, and keep the bonnet closed. Call 112 if you see flames.'
const PRICE_ENUM = /\b(?:PRICE_LEVEL_)?(FREE|INEXPENSIVE|MODERATE|EXPENSIVE|VERY_EXPENSIVE)\b/g
export const plain = (s: string) => s.replace(REF, '').replace(PRICE_ENUM, (_, e) => RUPEES[e])

// Call 1 input: system prompt + trimmed context + last 10 messages (Q22, Q23). `trip` is the state before this message.
export function pickMessages(trip: Trip, text: string, profile: Note[] = []): Msg[] {
  return [
    { role: 'system', content: SYSTEM + JSON.stringify(buildContext(trip, profile)) },
    ...history(trip),
    { role: 'user', content: text },
  ]
}

// Agent loop: the model (Super) calls tools each round. Data and memory tools run in code and feed back; find_stops
// ends the turn with a ranked answer (Ultra); reply ends it with text. `trip` is the state before the user's message.
export async function ask(p: MapProvider, trip: Trip, text: string, onStep = (_: string) => {},
  profile: Note[] = []): Promise<Answer> {
  const msgs = pickMessages(trip, text, profile)
  const smoke = isVehicleFire(text) // the app shows SAFETY itself; the model only searches
  if (smoke) msgs.push({ role: 'system', content: 'The app already shows the safety steps. Call find_stops now for a car mechanic (from_now 15); do not reply first.' })
  const safety = smoke ? SAFETY + ' ' : ''
  let forced = false
  const steps: Step[] = []
  const memory: Memory = { add: [], remove: [] }
  let link: string | undefined
  const departAt = departTime(text) // code guard: a named departure time always gets a real ETA (TESTSET #24)
  const note = (text: string, scope: 'trip' | 'profile') => {
    const id = 'n' + Math.random().toString(36).slice(2, 6)
    memory.add.push({ id, text, scope })
    return id
  }
  // A named deadline ("flight at 6 am") is compared with the arrival in code, and the verdict handed to the model (#62). A flight or
  // train goes to its airport / station. A one-moment deadline is kept as a trip note (it replaces an older one), and a later
  // "will we make it for the flight" reads it from there.
  const said = departAt ? null : deadlineOf(text, new Date(), trip.messages.slice(-2).map(m => m.text).join(' '))
  const saved = trip.notes.map(n => ({ n, d: noteDeadline(n.text) })).filter(x => x.d)
  const dl = said ? { ...said, at: said.at ?? (said.hub && saved.findLast(x => x.d!.hub === said.hub)?.d!.at) }
    : !departAt && MENTIONS.test(text) ? saved.at(-1)?.d ?? null : null
  if (said?.times.length === 1 && !saved.some(x => x.n.text === deadlineNote(dl!))) {
    memory.remove.push(...saved.map(x => x.n.id))
    note(deadlineNote(dl!), 'trip')
  }
  const verdict = dl && dl.times.some(t => t > Date.now()) ? await deadlineVerdict(p, trip, dl).catch(() => null) : null
  // Handed over before the first round: with only a reply guard the model searched "airport" and the ranker's cards ended the turn.
  // "No search" alone dropped the food in "airport by 6, want to eat on the way" (TESTSET #25, 2026-10-29): only the deadline is done.
  if (verdict) msgs.push({ role: 'system', content: `The user named a deadline, so the app worked it out: ${verdict} Use this for the ` +
    `deadline; no search or ETA for it. If the user also asked for a stop (food, fuel, a washroom), still find it.` })
  const hub = verdict?.match(/^Measured to (.+?)(?: \(|, not)/)?.[1] // the airport / station measured to: the reply names it
  let guarded = false, hubHeld = false
  const empty = new Set<string>() // find_stops args that returned 0 results this turn
  let nudged = false
  let scrubbed = false
  // ref -> the round it was warned in. A later round's call goes through (the model insists); a second call in the same
  // round does not (#60: make_link p3 twice in one round, the second made the Leopold buttons open a museum).
  const clashed = new Map<unknown, number>()
  const ran = new Map<string, string>() // tool + args -> result, for the calls that ran this turn
  let tier: CallType = 'pick' // Super, reasoning off; switches to 'plan' for planning-type questions
  const skipped: Step[] = [] // calls the code did not run: held back with a warning, or a repeat of one that ran
  const done = (text: string, extra: Partial<Answer> = {}): Answer => ({ text, steps, memory, link, skipped, ...extra })
  const fresh = new Set<string>() // refs eta_from_here measured this turn: their minutes are current
  let staled = false

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Last round: only reply is allowed, so a turn always ends in an answer.
    const last = round === MAX_ROUNDS - 1
    const choice: ToolChoice = last ? { type: 'function', function: { name: 'reply' } } : 'required'
    let m = await chat(tier, msgs, TOOLS, choice)
    // Planning question (sights near the destination; nobody waiting): redo this round on the planning tier (H1,
    // Ultra with reasoning), which knows which named sites fit a topic. Urgent questions never pay for this.
    if (tier === 'pick' && !last && m.tool_calls?.some(isPlanning)) {
      tier = 'plan'
      onStep('Thinking it through…')
      msgs.push({ role: 'system', content: PLAN_HINT })
      m = await chat(tier, msgs, TOOLS, choice)
    }
    const calls = m.tool_calls?.length ? m.tool_calls : leakedCall(m.content)
    // A tool call we could not recover must never reach the user as raw JSON.
    if (!calls.length) return done(/^\s*[[{]/.test(m.content ?? '') ? 'Sorry, I got mixed up there. Could you ask that again?' : m.content ?? '')
    msgs.push({ role: 'assistant', content: null, tool_calls: calls })
    // find_stops and reply end the turn: run them after the round's other calls, or a remember sent with the search is lost.
    for (const call of [...calls].sort((x, y) => +ENDS_TURN.has(x.function.name) - +ENDS_TURN.has(y.function.name))) {
      const name = call.function.name
      let args: any = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { /* bad args -> empty */ }
      // The same call twice in one turn gets the first result and costs nothing (#64: place_details x4 = 4 Enterprise calls).
      const key = name + JSON.stringify(args)
      if (ran.has(key)) {
        skipped.push({ name, args })
        msgs.push({ role: 'tool', tool_call_id: call.id, content: ran.get(key) + '\n(Same call as before, same result: answer with it.)' })
        continue
      }
      let result: string
      // The ref is not the place the user wrote (a name that is in no place of the trip, #60) or two places match it
      // ("haji ali": a dargah and a juice centre, #56): tell the model once per ref. Held calls are not steps.
      const warn = ON_CARD.has(name) && (clashed.get(args.ref) ?? round) === round ? refWarning(trip, text, target(trip, args.ref), args.ref !== 'destination') : null
      if (warn && !clashed.has(args.ref)) clashed.set(args.ref, round)
      ;(warn ? skipped : steps).push({ name, args })
      switch (warn ? 'warn' : name) {
        case 'warn':
          result = warn!
          break
        case 'reply':
          // A reply that announces work ("let me check", "more info coming") instead of doing it goes back once.
          if (!last && !nudged && PROMISE.test(String(args.text ?? ''))) {
            nudged = true
            result = 'Not sent: do not announce it, call the tool now.'
            break
          }
          if (smoke && !last && !forced && !steps.some(s => s.name === 'find_stops')) {
            forced = true
            result = 'Not sent: the app already shows the safety steps. Call find_stops now for a car mechanic (from_now 15).'
            break
          }
          if (!last && !scrubbed && (RAW_VALUE.test(String(args.text ?? '')) || META.test(String(args.text ?? '')))) {
            scrubbed = true
            result = 'Not sent: no field names, raw values or talk about instructions. Say it in plain words.'
            break
          }
          if (departAt && destination(trip) && !last && !guarded && !steps.some(s => s.name === 'eta_from_here')) {
            guarded = true
            steps.push({ name: 'eta_from_here', args: { ref: 'destination', depart_at: departAt, by: 'app' } })
            result = 'Not sent. The user named a departure time, so the app checked it: ' +
              await etaText(p, trip, 'destination', departAt) + '. Reply using this.'
            break
          }
          // Minutes from an old search stated as if current go back once; if they stay, the reply says how old they are.
          const old = staleMinutes(trip, String(args.text ?? ''), fresh)
          if (old.length && !last && !staled) {
            staled = true
            result = `Not sent: the minutes for ${old.map(o => o.name).join(', ')} are from an earlier search, from where the car was then. ` +
              'Call eta_from_here for a time from here, or leave the minutes out.'
            break
          }
          // A promise that got past the nudge (the forced last reply, #32; a second one): the promise goes, a useful rest stays.
          const kept = dropPromise(String(args.text ?? ''))
          if (!kept) return done(safety + GAVE_UP)
          const named = hub && !kept.toLowerCase().includes(hub.split(' ')[0].toLowerCase()) ? ` (Measured to ${hub}.)` : ''
          return done(safety + plain(kept) + named + old.map(o => ` (${o.name}: minutes from a search ${o.ago} min ago, not from here.)`).join(''))
        case 'find_stops': {
          const { save, ...a } = args as FindStopsArgs & { save?: string }
          if (ABSENT.test(String(a.similar_to ?? ''))) delete a.similar_to
          // A fact said inside the request (#44): saved like remember (Super skipped a second remember call 1 in 3 times).
          // Only diet / health / mobility facts: the model also put interests here ("interested in cotton mill history").
          if (save && LASTING.test(save) && ![...profile, ...trip.notes, ...memory.add].some(n => same(n.text, save))) note(String(save), scopeOf(text, String(save)))
          // A search for the airport / station the verdict already measured: its cards ended the turn without the verdict (ride
          // replay, "4pm from navi mumbai"). Held once; food on the way to the airport still runs.
          if (hub && !hubHeld && /airport|station/i.test(`${a.need} ${a.similar_to ?? ''} ${a.places ?? ''}`)) {
            hubHeld = true
            result = `Not run: the app already measured the deadline to ${hub} (in the system message). Reply with that verdict.`
            break
          }
          // The planning tier repeated an identical 0-result search until the forced reply (#32): don't run it again.
          const key = JSON.stringify(a)
          if (empty.has(key)) {
            result = 'Not run: this exact search already returned 0 results. Put specific site names in places, or tell the user honestly.'
            break
          }
          onStep(`Searching "${a.similar_to || a.need}" (${String(a.limit_type).replace('_', ' ')} ${a.limit_min} min)…`)
          const from = { lat: trip.fix.lat, lng: trip.fix.lng }, road = { fix: from, ahead: routeAhead(trip) }
          const found = (await findStops(p, road, a)).map(f => ({ ...f,
            ...(a.limit_type !== 'near_destination' && behind(f.location, road) && { behind: true as const }) }))
          if (!found.length) {
            empty.add(key)
            // Not a dead end: the model can retry with other words, a wider limit or another limit_type, or explain.
            result = `0 results for "${a.need}" (${a.limit_type} ${a.limit_min} min). Try once more differently: plainer ` +
              'words, a wider limit, another limit_type, or specific site names in places (for an event or topic). Or tell the user honestly.'
            tier = 'plan' // the retry is a planning problem: hand it to the planning tier
            break
          }
          onStep(`Ranking ${found.length} places…`)
          // Every candidate becomes a trip place (trip-stable ref); the search keeps its own minutes.
          const { places, refs } = upsertPlaces(trip.places, found.map(({ min, detour_min, from_dest, asked_for, behind, ...place }) => place))
          const candidates = found.map(({ min, detour_min, from_dest, asked_for }, i) => ({ ref: refs[i], min,
            ...(detour_min != null && { detour_min }), ...(from_dest && { from_dest }), ...(asked_for && { asked_for }) }))
          // The ranker weighs every note in force, including ones saved earlier in this turn.
          const notes = [...profile, ...trip.notes, ...memory.add].filter(n => !memory.remove.includes(n.id)).map(n => n.text)
          const { say, picks } = await rank(text, a, found.map((f, i) => ({ ...f, ref: refs[i] })), notes)
          const search: Search = { id: `s${trip.searches.length + 1}`, at: istIso(), from, asked: text, args: a, candidates, picks, say }
          return done(safety + say, { places, search })
        }
        case 'end_trip':
          return done('Tap End trip below to finish this trip, or Keep going.', { end: true })
        case 'get_trip_state':
          result = tripState(trip, args.section)
          // The model asks old chat for facts about the people that sit in the context's profile, finds none and says
          // "I don't recall" (#55, F7 9): that answer always ends with the saved facts.
          if (args.section === 'older_messages') {
            const facts = [...profile, ...trip.notes, ...memory.add].filter(n => !memory.remove.includes(n.id)).map(n => n.text)
            result += `\nSaved facts about the people (the only ones that count): ${facts.join('; ') || 'none'}.`
          }
          break
        case 'remember': {
          const scope = scopeOf(text, String(args.note ?? ''))
          result = `saved as ${note(String(args.note ?? ''), scope)}, ${scope === 'trip' ? 'for this trip only' : 'for every trip'}`
          break
        }
        case 'forget':
          memory.remove.push(String(args.note_id))
          result = `deleted ${args.note_id}`
          break
        case 'place_details': {
          const id = trip.places[target(trip, args.ref) ?? '']?.place_id
          result = id ? await safe(async () => JSON.stringify(await p.details(id))) : UNKNOWN_REF
          break
        }
        case 'eta_from_here': {
          // A time parsed from the user's words (IST, rolls to tomorrow) beats the model's guess at an ISO string.
          // A deadline is not a departure: the model's depart_at (06:00 for "flight at 6", #53) is dropped, leaving now.
          const at = departAt ?? (verdict ? undefined : args.depart_at)
          if (!at && !args.from) fresh.add(target(trip, args.ref) ?? '')
          // The destination or a plan entry, leaving now: the trip's own numbers, so the reply and the trip bar agree (#63).
          const entry = !at && args.from !== 'destination' && ahead(trip).find(a => a.ref === target(trip, args.ref ?? 'destination'))
          // from: 'destination' = Routes from where the trip ends to the ref ("how far is X from the gallery", #61).
          const origin = args.from === 'destination' ? destination(trip) : null
          // A card of a search measured from the destination also gets that search's minutes, labelled (#49).
          result = entry ? `${entry.name}: ${entry.min} min, ${entry.km} km, leaving now, arriving about ` +
              `${hhmm(Date.now() + entry.min * 60_000)} (the trip's own estimate).`
            : [!at && !origin && fromDest(trip, args.ref), await safe(() => etaText(p, trip, args.ref, at, origin))]
              .filter(Boolean).join('\nFrom the car: ')
          break
        }
        case 'web_search':
          result = await safe(async () => {
            const r = await post<any>('/search', { query: String(args.query ?? '') })
            return JSON.stringify((r.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: String(x.content ?? '').slice(0, 300) })))
          })
          break
        case 'make_link': {
          const ref = target(trip, args.ref)
          if (ref) link = ref
          result = ref ? `Links for ${trip.places[ref].name} are shown under your reply as buttons labelled "Open in Maps", "Uber" ` +
            'and "WhatsApp" (shares the place). Name them exactly so. Do not write any links yourself.' : UNKNOWN_REF
          break
        }
        default:
          result = `Unknown tool ${name}.`
      }
      if (!ENDS_TURN.has(name) && !warn) ran.set(key, result) // a "Not run" warning is not a result: the repeat may go through
      msgs.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }
  return done('Sorry, I got stuck on that one. Could you say it another way?') // only if the forced reply fails
}

// Planning-type search: sights near the destination, or named places off the urgent path. Urgent (from_now)
// searches never escalate, so rescue answers stay fast. similar_to alone is a brand lookup, not planning: "like
// Domino's, max 10 min detour" escalated and took ~90 s.
export function isPlanning(c: ToolCall): boolean {
  if (c.function.name !== 'find_stops') return false
  let a: any = {}
  try { a = JSON.parse(c.function.arguments) } catch { return false }
  return a.limit_type === 'near_destination' || (a.limit_type !== 'from_now' && a.places?.length > 0)
}

// Nemotron with reasoning on sometimes writes the tool call as text ([{"name": ..., "parameters": ...}]) instead of
// calling it (seen with Nano on day 1 and Ultra on TESTSET #34). Recover it rather than show JSON to the user.
export function leakedCall(content: string | null): ToolCall[] {
  const s = content ?? ''
  const start = s.search(/[[{]/)
  if (start < 0 || !s.includes('"name"')) return []
  // The first complete JSON value from the first bracket: there may be a second block or prose after it.
  for (let end = start + 1; end < s.length; end++) {
    if (s[end] !== '}' && s[end] !== ']') continue
    let raw: any
    try { raw = JSON.parse(s.slice(start, end + 1)) } catch { continue }
    const c = Array.isArray(raw) ? raw[0] : raw
    if (!TOOLS.some(t => t.function.name === c?.name)) return []
    return [{ id: 'leaked', type: 'function', function: { name: c.name, arguments: JSON.stringify(c.parameters ?? c.arguments ?? {}) } }]
  }
  return []
}

// The next destination to reach (the last one once all are reached). Null with no destination (G2).
const destination = (trip: Trip) => {
  const ds = trip.plan.filter(e => e.kind === 'destination')
  return (ds.find(e => !e.reached_at) ?? ds.at(-1))?.ref ?? null
}
// The tools that act on one card: a clash between two same-named places is checked before they run.
const ON_CARD = new Set(['place_details', 'eta_from_here', 'make_link'])
// Names of the places that tie for the most words (2+) in common with what the user wrote, when the ref the model chose is
// one of them and the tied names differ; else null. ("tell me more about haji ali": Haji Ali Dargah / Haji Ali Juice Centre.)
export function nameClash(trip: Trip, text: string, ref: string | null): string[] | null {
  const words = (s: string) => s.toLowerCase().match(/[a-zऀ-ॿ']{3,}/g) ?? []
  const said = new Set(words(text))
  const scored = Object.entries(trip.places).map(([r, p]) => ({ r, name: p.name, n: words(p.name).filter(w => said.has(w)).length }))
  const best = Math.max(0, ...scored.map(s => s.n))
  const top = scored.filter(s => s.n === best)
  const names = [...new Set(top.map(s => s.name))]
  return best >= 2 && names.length > 1 && top.some(s => s.r === ref) ? names : null
}
// Words that are not place names. A user word outside this list that no place of the trip has means a place not in the
// trip yet (#60: "is Leopold open now?" with place_details on the Gateway of India).
const COMMON = new Set(('open opens opening closed close closes closing closest nearest near nearby now today tomorrow tonight send share forward ' +
  'family friends papa mummy mom dad wife kids how what when where which who whom whose why will would should could does did have has had ' +
  'any some with from into onto your yours ours our they them then than just also only still even very really actually please okay yeah yes ' +
  'not dont cant give show tell more much many about around across along away over under again before after until while want need like ' +
  'find look check whether know long short time times minute minutes mins hour hours reach reaching arrive arrival drive driving take takes ' +
  'going gone come coming back stop stops place places spot spots food eat eating drink wait table parking price prices cost cheap cheaper ' +
  'pricey expensive rating rated review reviews menu phone number address link links maps map uber whatsapp famous popular good great best ' +
  'worth details info information crowd crowded busy quiet till until reach reaches reached getting gets make makes made goes went put ' +
  'bring stay leave left start started end ends keep let lets try use help call called ask asked see seen visit buy order book pay ride ' +
  'something anything everything nothing someone anyone somewhere anywhere because since though however nice cool hot cold warm clean ' +
  'dirty big small little large new old fresh late early fast slow easy hard free full real sure ready safe sorry people person kids ' +
  'child children baby toddler grandma grandpa mother father sister brother lunch dinner breakfast snack coffee water road highway ' +
  'traffic route petrol diesel pump fuel toilet washroom restroom morning evening night afternoon week weekend left right straight ' +
  'kya hai hain kitna kitni kitne door paas wahan yahan abhi mein main bhej bhejo khula khuli band batao bata kaise kaisa kab ghar ' +
  'ko ka ki ke se ye wo isko usko mujhe humein hume pahunch pahunchenge lagega lagenge ahead behind washrooms toilets restrooms').split(' '))
// A pronoun or an ordinal points at a card, not at a name ("is it open", "the second one", "#3"): never checked.
const POINTS_AT_CARD = /\b(it|its|this|that|these|those|there|here|they|them|one|ones|first|second|third|last|previous|above|same|\d+(st|nd|rd|th))\b|#\d/i

// A reason not to run a place tool on `ref` for what the user wrote, as the tool result; else null. Once per ref (the caller).
// words = false when the model said "destination": the user meant the trip's end, so only a name clash is checked.
export function refWarning(trip: Trip, text: string, ref: string | null, words = true): string | null {
  const clash = nameClash(trip, text, ref)
  if (clash) {
    return `Not run: more than one place matches what the user wrote (${clash.join(' / ')}). Ask which one they mean, ` +
      `or call find_stops with the full name of the one they mean in places. Do not use ${ref} for either.`
  }
  if (!ref || !words || POINTS_AT_CARD.test(text)) return null
  const said = text.toLowerCase().match(/[a-zऀ-ॿ]{4,}/g) ?? []
  const mine = trip.places[ref].name.toLowerCase(), names = Object.values(trip.places).map(p => p.name.toLowerCase()).join('|')
  if (said.some(w => mine.includes(w))) return null // the ref's own place is named
  // A capitalised word after the first is a name (precise); with none, any word outside COMMON may be one (typed in lowercase).
  const caps = [...text.matchAll(/\s([A-Z][a-z]{3,})/g)].map(m => m[1].toLowerCase())
  const word = (caps.length ? caps : said).find(w => !COMMON.has(w) && !names.includes(w))
  return word ? `Not run: ${ref} is ${trip.places[ref].name}, not what the user named ("${word}" is no place in this trip). ` +
    `Call find_stops with the full name of the place they named in places. Do not use ${ref} for it.` : null
}
// A ref from the context (trip-stable, so any place seen in this trip), or 'destination'.
function target(trip: Trip, ref: unknown): string | null {
  if (ref === 'destination') return destination(trip)
  return typeof ref === 'string' && trip.places[ref] ? ref : null
}
const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase()
const UNKNOWN_REF ="Unknown ref. Use a ref from the context (ahead, last_search, cards_shown_earlier) or 'destination'."
const safe = (f: () => Promise<string>) => f().catch(e => `Error: ${e instanceof Error ? e.message : e}`)
const istDay = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
// "7:45 pm", or "tomorrow 7:45 pm" when it is not today in IST.
const hhmm = (ms: number) => (istDay(ms) === istDay(Date.now()) ? '' : 'tomorrow ') +
  new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })

// The last search's minutes for a card, when that search was measured from the destination (near_destination).
export function fromDest(trip: Trip, ref: unknown): string | null {
  const s = trip.searches.at(-1), r = target(trip, ref)
  const c = s?.candidates.find(c => c.ref === r && c.from_dest)
  return s && c ? `${trip.places[c.ref].name}: ${c.min} min from the destination (last search, ${minutesSince(s.at)} min ago; ` +
    'not the drive from the car).' : null
}

// Deadline vs arrival (arrival = now + the minutes ahead to the destination), worked out here: the model read "6 am" at 17:56 as
// the 7:02 arrival's am (#62). One line per moment the time can mean (a bare hour is am and pm).
// hub: a flight or train's airport / station instead (lead = which one and how far; buffer = minutes to be there before).
export type Hub = { lead: string; min: number; what: string; buffer: number }
export function deadlineText(trip: Trip, times: number[], now = Date.now(), hub?: Hub): string | null {
  const dest = ahead(trip).find(a => a.ref === destination(trip))
  if (!(hub ?? dest) || !times.length) return null
  const arrive = now + (hub ?? dest)!.min * 60_000, buffer = (hub?.buffer ?? 0) * 60_000
  const span = (ms: number) => { const m = Math.round(ms / 60_000); return `${m >= 60 ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min` }
  const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }) +
    (istDay(ms) === istDay(now) ? ' today' : istDay(ms) === istDay(now + 864e5) ? ' tomorrow' : ` on ${istDay(ms)}`)
  const one = (t: number) => { const d = t - buffer; return `${hub?.what ?? 'deadline'} ${clock(t)}` +
    (buffer ? `, so be there by ${clock(d)} (${hub!.buffer} min before)` : '') + `, arrival about ${clock(arrive)}: ` +
    (d >= arrive ? `${span(d - arrive)} to spare` : `arrives ${span(arrive - d)} late`) }
  return `${hub ? hub.lead : `${dest!.name} is ${dest!.min} min ahead.`} ` + times.map(one).join(' OR ') +
    (times.length > 1 ? '. The user did not say am or pm: ask which, or give both.' : '.')
}
// A flight / train deadline: the airport or station the user named, else the one nearest the destination (or the car), and the drive
// to it from the car (one Places call; its routing gives the minutes). Other deadlines: the destination, as before.
export async function deadlineVerdict(p: MapProvider, trip: Trip, d: Deadline, now = Date.now()): Promise<string | null> {
  if (!d.hub) return deadlineText(trip, d.times, now)
  const end = trip.places[destination(trip) ?? '']
  const center = end?.location ?? trip.fix
  const hits = await p.searchNear(d.at ? `${d.at} ${d.hub}` : d.hub, center, 50000, 5, trip.fix).catch(() => [])
  // Google's type first (not an airport hotel or shuttle), an international airport before an airstrip (Juhu Aerodrome, TESTSET
  // #25 2026-10-29), else the name.
  const [type, name] = d.hub === 'airport' ? [/^(international_)?airport$/, /\bairport\b/i] : [/^train_station$/, /\b(station|junction|terminus)\b/i]
  const typed = hits.filter(h => type.test(h.type ?? '')), intl = typed.filter(h => h.type === 'international_airport')
  const ok = intl.length ? intl : typed.length ? typed : hits.filter(h => name.test(h.name))
  const hub = d.at ? ok[0] : ok.sort((x, y) => km(x.location, center) - km(y.location, center))[0]
  if (!hub) return `No ${d.hub} found${d.at ? ` for "${d.at}"` : ''} on Google: ask which ${d.hub} the user means.`
  const sec = Number.isFinite(hub.legsSec[0]) ? hub.legsSec[0] : (await p.eta(trip.fix, hub.location)).durationSec
  const min = Math.round(sec / 60)
  return deadlineText(trip, d.times, now, { min, what: d.what, buffer: d.buffer,
    lead: `Measured to ${hub.name}${d.at ? '' : ` (assumed: the ${d.hub} nearest ${end ? end.name.split(',')[0] : 'here'}; the user named none, so say so)`}, ` +
      `not to the trip's destination: ${min} min from the car (Google traffic now).` })
}
// Places in a reply with minutes from a search more than STALE_MIN ago from the car: not current (ride 2026-10-18: "Shiv Vadapav
// Centre (2 min)" 28 min and ~9 km after that search). Plan entries (live minutes) and refs measured this turn are fine.
// ponytail: a name is found by its first two words with minutes within ~30 characters after it.
export function staleMinutes(trip: Trip, text: string, fresh: Set<string>, now = Date.now()): { name: string; ago: number }[] {
  const flat = (s: string) => s.replace(/[’‘`]/g, "'").toLowerCase()
  const said = flat(text), live = new Set([...fresh, ...ahead(trip).map(a => a.ref)]), seen = new Set<string>()
  return [...trip.searches].reverse().flatMap(s => s.candidates.filter(c => !seen.has(c.ref) && seen.add(c.ref)).flatMap(c => {
    const name = trip.places[c.ref]?.name
    if (!name || !stale(s, now) || live.has(c.ref)) return []
    const key = flat(name).split(/\s+/).slice(0, 2).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`${key}[^.;,\\n]{0,30}?\\b\\d+\\s*(min|mins|minutes?)\\b`).test(said) ? [{ name, ago: minutesSince(s.at, now) }] : []
  }))
}

// eta_from_here: drive time from the latest fix, or from the place `from` (the destination's ref). A past or bad depart_at
// falls back to leaving now.
async function etaText(p: MapProvider, trip: Trip, ref: unknown, departAt?: string, from?: string | null): Promise<string> {
  const t = trip.places[target(trip, ref ?? 'destination') ?? '']
  if (!t) return UNKNOWN_REF
  const o = from ? trip.places[from] : null
  const start = Date.parse(departAt ?? '')
  const future = start > Date.now() ? new Date(start).toISOString() : undefined
  const { durationSec, distanceM } = await p.eta(o?.location ?? trip.fix, t.location, future)
  const leave = future ? Date.parse(future) : Date.now()
  const passed = departAt && !future ? 'The asked departure time has already passed, so this is for leaving now. ' : ''
  const traffic = `Google traffic ${future ? 'forecast' : 'now'}`
  return `${passed}${t.name}: ${Math.round(durationSec / 60)} min, ${(distanceM / 1000).toFixed(1)} km, ` + (o
    ? `from ${o.name} (the destination), not from the car (${traffic}).`
    : `leaving ${future ? hhmm(leave) : 'now'}, arriving about ${hhmm(leave + durationSec * 1000)} (${traffic}).`) // no instruction text here: the model echoed it ("no extra claim added", #B16)
}

// make_link buttons for a message's link ref: plain URLs, no API call. Uber gets the drop-off only; the passenger
// picks up where they are. Minutes only when the place is ahead in the plan (a search's minutes go stale).
export function linksFor(trip: Trip, ref: string): Links {
  const t = trip.places[ref]
  const { lat, lng } = t.location
  const min = ahead(trip).find(a => a.ref === ref)?.min
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving` +
    (t.place_id ? `&destination_place_id=${t.place_id}` : '')
  const uber = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${lat}` +
    `&dropoff[longitude]=${lng}&dropoff[nickname]=${encodeURIComponent(t.name)}`
  const share = `Let's stop at ${t.name}${t.rating ? ` (${t.rating}★)` : ''}${min != null ? `, ${min} min away` : ''}: ${maps}`
  // whatsapp_app opens the app directly (the wa.me page opens first inside the installed PWA); wa.me is its fallback.
  return { label: t.name, maps, uber, whatsapp: `https://wa.me/?text=${encodeURIComponent(share)}`,
    whatsapp_app: `whatsapp://send?text=${encodeURIComponent(share)}` }
}

// get_trip_state (Q27): detail left out of the context block.
// The plan as one line, first in the steps and searches results: they were read as "the stops" (TESTSET #52).
export function planText(trip: Trip): string {
  const reached = trip.plan.filter(e => e.reached_at).map(e => trip.places[e.ref].name)
  return `The plan: ${ahead(trip).map(a => `${a.name} (${a.kind}, ${a.min} min)`).join(' > ') || 'nothing ahead'}` +
    `${reached.length ? `; reached: ${reached.join(', ')}` : ''}.\n`
}

function tripState(trip: Trip, section: string): string {
  if (section === 'steps') {
    // Every turn still ahead: the current leg cut at the fix, then each later leg whole.
    const out = legsAhead(trip).flatMap((l, i) => [`To ${trip.places[l.to].name}:`,
      ...(i ? l.steps : nextSteps(trip)).map(s => `- ${s.text} (${s.km.toFixed(1)} km)`)])
    return planText(trip) + (out.join('\n') || 'No route ahead.')
  }
  if (section === 'searches') {
    return planText(trip) + (trip.searches.length ? 'Earlier searches (cards shown, not the plan): ' +
      JSON.stringify(trip.searches.map(s => ({ id: s.id, ...searchView(trip, s), picks: s.picks.map(p => p.ref) }))) : 'No searches yet.')
  }
  // TESTSET #54: the model repeated a note the user had deleted, quoted in old chat. Lasting facts live in notes and profile
  // only, so older lines that state one (diet, allergy, health, mobility) are left out, and the rest carries a warning.
  const older = trip.messages.slice(0, -10).filter(m => !LASTING.test(m.text))
  return older.length ? 'Older chat. It may quote notes the user has since deleted: take no facts about the people from it ' +
    '(only notes and profile in the context count).\n' + older.map(m => `${m.role}: ${m.text}`).join('\n')
    : 'Nothing older than the messages you already have.'
}

// Call 2: Ultra picks the best 3 of the candidates. Never invents places: only refs that are real candidates survive.
export async function rank(text: string, args: FindStopsArgs, found: (Found & { ref: string; behind?: true })[], notes: string[]):
  Promise<{ say: string; picks: { ref: string; reason: string }[] }> {
  const r = await chat('rank', [
    { role: 'system', content: RANK },
    { role: 'user', content: JSON.stringify({
      request: text,
      limit: `${args.limit_type} ${args.limit_min} min`,
      notes: [args.notes, ...notes].filter(Boolean),
      candidates: found.map(c => ({ ref: c.ref, name: c.name, min_from_here: c.min, detour_min: c.detour_min,
        rating: c.rating, reviews: c.reviews, price: priceSymbol(c.price), open_now: c.open_now, type: c.type, serves_veg: c.serves_veg,
        ...(c.from_dest && { minutes_are_from_destination: true }), ...(c.asked_for && { asked_for: true }), ...(c.behind && { behind_car: true }) })),
    }) },
  ])
  const out = parseJson(r.content ?? '')
  const by = new Map(found.map(c => [c.ref, c]))
  // History and labels are not in the data (#59 "Iconic hotel attacked on 26/11", #67 "General hospital" on a heart institute):
  // a reason with a date, a year or attack talk the name does not carry is blanked; "general" stays only where the name says it.
  const clean = (ref: string, s: string) => {
    s = plain(s)
    const name = by.get(ref)?.name ?? ''
    return invented(s, [name]) ? '' : /general/i.test(name) ? s : s.replace(/\bgeneral\s+/gi, '')
  }
  const picks = [...new Map<string, { ref: string; reason: string }>((out?.top ?? []).filter((t: any) => by.has(t.ref))
    .map((t: any) => [t.ref, { ref: t.ref, reason: clean(t.ref, String(t.reason ?? '')) }])).values()].slice(0, 3)
  if (!picks.length) return { say: 'Here are the closest matches.', picks: found.slice(0, 3).map(c => ({ ref: c.ref, reason: '' })) }
  // An emergency: the nearest of the picks first, whatever the ranker preferred (#67: a 14 min hospital ahead of a 2 min one).
  if (/emergency/i.test(args.notes ?? '')) {
    picks.sort((x, y) => by.get(x.ref)!.min - by.get(y.ref)!.min)
    return { say: picks.map(p => `${by.get(p.ref)!.name}: ${by.get(p.ref)!.min} min`).join('. ') + '.', picks }
  }
  // The ranker chooses which 3; code orders them: ahead of the car first, nearest first, behind it last (ride 2026-10-18, 11).
  if (args.limit_type !== 'near_destination') picks.sort((x, y) => { const a = by.get(x.ref)!, b = by.get(y.ref)!; return +!!a.behind - +!!b.behind || a.min - b.min })
  let say = plain(String(out.say ?? ''))
  // Minutes from the destination never read as from here: "Navi Mumbai Airport is 20 minutes away" was 20 from the hotel, 91 from the car.
  if (found.some(c => c.from_dest)) say = say.replace(/\b(\d+)\s*(min(?:ute)?s?)\b(?:\s+away)?(?!\s+(?:from|of)\b)/gi, '$1 $2 from the destination')
  return { say: invented(say, picks.map(p => by.get(p.ref)!.name)) ? 'Here are the closest matches.' : say, picks }
}
const CLAIM = /\b\d{1,2}\/\d{1,2}\b|\b(?:1[5-9]|20)\d{2}\b|\battack/gi
// A claim the given names don't carry ("1947" is fine when a pick is "1947 Restaurant": F7 2 lost its whole say).
const invented = (s: string, names: string[]) =>
  [...s.matchAll(CLAIM)].some(m => !names.some(n => n.toLowerCase().includes(m[0].toLowerCase())))

function parseJson(s: string): any {
  try {
    return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
  } catch {
    return null
  }
}
