import { along, decode, encode, km, OFF_ROUTE_KM } from './geo.ts'
import { istIso } from './time.ts'
import type { Msg } from './llm.ts'
import type { Candidate, LatLng, Message, Note, Place, PlanEntry, RouteLeg, Search, Step, Trip } from './types.ts'

// Trip model v2 (DESIGN.md): what is computed on read from the stored facts, the few pure rules that write them
// (a fix, a new place, a new stop), and the trimmed context block for the model (Q22).

const REACH_KM = 0.1 // a plan entry is reached at ~100 m
const LIVE_KM = 1 // live GPS takes over when a fix lands within ~1 km of the origin
const STILL_KM = 0.15, STILL_MIN = 4 // a real stop: within ~150 m for 4+ min (Shruti, 2026-10-21)

// Google's legs to entries not reached yet, in order. The first is the current leg (it starts at the fix of the last
// refresh). Reaching a stop does not refresh the route: its leg drops out here and the next one is current.
export const legsAhead = (t: Trip) => (t.route ?? []).filter(l => t.plan.some(e => e.ref === l.to && !e.reached_at))

// Share of a leg still ahead of p, by distance along its polyline.
function left(l: RouteLeg, p: LatLng) {
  const a = along(l.polyline, p)
  return a.totalKm > 0 ? Math.max(0, 1 - a.doneKm / a.totalKm) : 0
}

// Per unreached plan entry: km and minutes from the fix. Current leg = its duration x share still ahead (even speed);
// later legs whole; cumulative.
export type Ahead = { ref: string; name: string; kind: PlanEntry['kind']; km: number; min: number }
export function ahead(t: Trip): Ahead[] {
  let sec = 0, m = 0
  return legsAhead(t).map((l, i) => {
    const share = i ? 1 : left(l, t.fix)
    sec += l.duration_sec * share
    m += l.distance_m * share
    return { ref: l.to, name: t.places[l.to].name, kind: t.plan.find(e => e.ref === l.to)!.kind,
      km: Math.round(m / 100) / 10, min: Math.round(sec / 60) }
  })
}

// The current leg's steps cut at the fix.
export function nextSteps(t: Trip): Step[] {
  const leg = legsAhead(t)[0]
  if (!leg) return []
  let skip = along(leg.polyline, t.fix).doneKm
  const out: Step[] = []
  for (const s of leg.steps) {
    if (skip >= s.km) { skip -= s.km; continue }
    out.push(skip > 0 ? { ...s, km: Math.round((s.km - skip) * 10) / 10 } : s)
    skip = 0
  }
  return out
}

// The road the fix is on: the last road named by a step up to the one the fix falls in ("Turn left onto Inner Ring Rd" ->
// "on Inner Ring Rd"; "Keep right to take the flyover" names none, so the road before it stands). Null with none named.
// TESTSET #65: 5.7 km along the route the model answered "starting from Charminar", the trip's origin.
export function onRoad(t: Trip): string | null {
  const leg = legsAhead(t)[0]
  if (!leg) return null
  let done = along(leg.polyline, t.fix).doneKm, road: string | undefined
  for (const s of leg.steps) {
    road = (s.text.match(/\bonto (.+)$/i) ?? s.text.match(/\bon (.+)$/i))?.[1]?.split(/ toward(?:s)? /i)[0].trim() ?? road
    if (done < s.km) break
    done -= s.km
  }
  return road ? `on ${road}` : null
}

export const offRoute = (t: Trip) => {
  const leg = legsAhead(t)[0]
  return !!leg && along(leg.polyline, t.fix).offKm > OFF_ROUTE_KM
}

// Every destination in the plan reached (Q24: "Arrived. Anything next?"). A trip with no destination never arrives.
export const arrived = (t: Trip) => t.plan.some(e => e.kind === 'destination') &&
  t.plan.every(e => e.kind !== 'destination' || !!e.reached_at)

// Places the user saw as cards: picks of all searches, each once, newest 20, oldest first.
export function shown(t: Trip): string[] {
  const refs = [...new Set(t.searches.flatMap(s => s.picks.map(p => p.ref)).reverse())].slice(0, 20)
  return refs.reverse()
}

// The road still ahead as one polyline from the fix, and its drive time. Null with nothing left to reach (G2, arrived).
export function routeAhead(t: Trip): { polyline: string; sec: number } | null {
  const legs = legsAhead(t)
  if (!legs.length) return null
  return {
    polyline: encode(legs.flatMap((l, i) => decode(i ? l.polyline : along(l.polyline, t.fix).rest))),
    sec: legs.reduce((s, l, i) => s + l.duration_sec * (i ? 1 : left(l, t.fix)), 0),
  }
}

// Cards of one search: its picks with their place facts and the search's own minutes.
export type Card = Place & Omit<Candidate, 'ref'> & { ref: string; reason: string }
export function cards(t: Trip, searchId?: string): Card[] {
  const s = t.searches.find(s => s.id === searchId)
  return s ? s.picks.map(p => ({ ...t.places[p.ref], ...s.candidates.find(c => c.ref === p.ref)!, reason: p.reason })) : []
}

// --- Rules that write facts (code only, Q17) ---

// A trip at Start. From a picked place: not live until GPS shows the phone is there. From the current location: live.
export function newTrip(origin: Place, dest?: Place, leg?: Omit<RouteLeg, 'to'>): Trip {
  const at = istIso()
  return {
    id: at, origin: 'p1',
    plan: dest ? [{ ref: 'p2', kind: 'destination', reached_at: null }] : [],
    fix: { ...origin.location, t: at },
    live: origin.place_id === null,
    route: dest && leg ? [{ to: 'p2', ...leg }] : null,
    places: dest ? { p1: origin, p2: dest } : { p1: origin },
    searches: [], notes: [], messages: [],
  }
}

// One position reading from live GPS (gps) or replay. Live GPS counts only once the trip is live, or when the fix lands
// near the origin (then the trip goes live). Entries within ~100 m of the fix get reached_at. The plan keeps its
// identity when nothing was reached. `still` follows the stay: a fix within ~150 m of its start keeps it, so a hidden
// app coming back where it was counts the hidden minutes.
export function applyFix(t: Trip, p: LatLng, gps: boolean, at = istIso()): Trip {
  const live = t.live || (gps && km(p, t.places[t.origin].location) <= LIVE_KM)
  if (gps && !live) return t
  // The place itself, or where Google's leg to it ends (a big place's pin can sit far from its road entrance).
  const near = (e: PlanEntry) => {
    const end = t.route?.find(l => l.to === e.ref)
    return [t.places[e.ref].location, end && decode(end.polyline).at(-1)].some(q => q && km(p, q) <= REACH_KM)
  }
  const hit = t.plan.some(e => !e.reached_at && near(e))
  const still = t.still && km(p, t.still) <= STILL_KM ? t.still : { ...p, t: at }
  const next = { ...t, live, fix: { ...p, t: at }, still,
    plan: hit ? t.plan.map(e => (!e.reached_at && near(e) ? { ...e, reached_at: at } : e)) : t.plan }
  return live ? logStop(next) : next
}

// Every real stop goes into the trip (#3): a live stay of 4+ min away from the origin and every plan entry becomes a stop
// reached at the stay's start, so it is never routed through. It sits where the car is now (parked; the stay's first fix
// is often the street). "Stop at HH:MM" until the app names it after the nearest Google place.
// ponytail: a jam that stands still 4+ min counts too; ignore stays on the route polyline if that gets noisy.
function logStop(t: Trip): Trip {
  const s = t.still!, at = { lat: t.fix.lat, lng: t.fix.lng }
  if (Date.parse(t.fix.t) - Date.parse(s.t) < STILL_MIN * 60_000) return t
  if ([t.origin, ...t.plan.map(e => e.ref)].some(r => km(at, t.places[r].location) <= STILL_KM)) return t
  const { places, refs: [ref] } = upsertPlaces(t.places, [{ place_id: null, name: `Stop at ${s.t.slice(11, 16)}`, location: at }])
  const i = t.plan.findIndex(e => !e.reached_at), e: PlanEntry = { ref, kind: 'stop', reached_at: s.t }
  return { ...t, places, plan: i < 0 ? [...t.plan, e] : [...t.plan.slice(0, i), e, ...t.plan.slice(i)] }
}

// Places by place_id: a place seen again keeps its ref and its facts are replaced whole; a new one gets the next ref.
export function upsertPlaces(places: Record<string, Place>, list: Place[]) {
  const out = { ...places }
  const refs = list.map(p => {
    const ref = (p.place_id && Object.keys(out).find(r => out[r].place_id === p.place_id)) || `p${Object.keys(out).length + 1}`
    out[ref] = p
    return ref
  })
  return { places: out, refs }
}

// Add stop: before the next unreached destination, after earlier stops (no reordering). Already planned: unchanged.
export function withStop(plan: PlanEntry[], ref: string): PlanEntry[] {
  if (plan.some(e => e.ref === ref && !e.reached_at)) return plan
  const i = plan.findIndex(e => e.kind === 'destination' && !e.reached_at)
  const e: PlanEntry = { ref, kind: 'stop', reached_at: null }
  return i < 0 ? [...plan, e] : [...plan.slice(0, i), e, ...plan.slice(i)]
}

// --- What the model sees ---

const withId = (n: Note) => `${n.id}: ${n.text}` // ids so forget(note_id) can name them
const named = (t: Trip, ref: string) => `${ref} ${t.places[ref]?.name ?? '?'}`
export const minutesSince = (iso: string, now = Date.now()) => Math.round((now - Date.parse(iso)) / 60_000)

// A deleted note (Profile screen or forget) is written into the chat as a line the model reads and the user sees.
const FORGOT = 'Forgot: '
export const forgotLine = (note: string): Message => ({ role: 'assistant', text: FORGOT + note })
// An earlier line that restates a deleted note (2/3 of its words of 4+ letters, or the whole text) is not shown to the model:
// it repeated "dad avoids spicy food" from the chat after the note was deleted (TESTSET #54).
function restates(t: Trip, i: number) {
  const text = t.messages[i].text.toLowerCase()
  return !text.startsWith(FORGOT.toLowerCase()) && t.messages.slice(i + 1).some(m => {
    if (!m.text.startsWith(FORGOT)) return false
    const gone = m.text.slice(FORGOT.length).toLowerCase(), words = gone.match(/[a-z]{4,}/g) ?? []
    // Two thirds of the words, not all: the model's own paraphrase ("doesn't like spicy food" for "hates spicy food") leaked.
    return text.includes(gone) || (words.length > 0 && words.filter(w => text.includes(w)).length >= Math.ceil(words.length * 2 / 3))
  })
}

// Chat history: the last 10 messages. Searches and links carry their refs, which are trip-stable.
export function history(t: Trip): Msg[] {
  return t.messages.map((m, i) => ({ m, i })).slice(-10).map(({ m, i }) => {
    const s = m.search && t.searches.find(s => s.id === m.search)
    const tail = s ? ` Options${stale(s) ? ` (minutes in this line are from ${minutesSince(s.at)} min ago, not from here)` : ''}: ` + s.picks.map(p => named(t, p.ref)).join(', ') : m.link ? ' Link: ' + named(t, m.link) : ''
    // The "Forgot: <note>" line itself carried the fact back: the model read it as one (F7 7, 2026-10-10). It gets no text.
    const text = m.text.startsWith(FORGOT) ? '(The user deleted a saved note. It no longer applies.)'
      : restates(t, i) ? '(a line about a note the user deleted, left out)' : m.text
    return { role: m.role, content: text + tail }
  })
}

// Google's price levels as shown to people (cards) and to the model: the model copies what it reads (TESTSET #47: "MODERATE").
export const RUPEES: Record<string, string> = { FREE: 'free', INEXPENSIVE: '₹', MODERATE: '₹₹', EXPENSIVE: '₹₹₹', VERY_EXPENSIVE: '₹₹₹₹' }
export const priceSymbol = (level?: string) => (level && RUPEES[level]) || level

// A search's minutes from the car go stale once it has moved on: the model quoted a 28 min old "2 min" as current (ride 2026-10-18).
export const STALE_MIN = 5
export const stale = (s: Search, now = Date.now()) => !s.candidates.some(c => c.from_dest) && minutesSince(s.at, now) > STALE_MIN
// One search as the model reads it: all candidates with this search's minutes (last_search; get_trip_state searches). Stale minutes are left out.
export function searchView(t: Trip, s: Search) {
  const old = stale(s)
  return {
    asked: s.asked,
    limit: `${s.args.limit_type.replace('_', ' ')} ${s.args.limit_min} min`,
    found_min_ago: minutesSince(s.at),
    minutes_from: s.candidates.some(c => c.from_dest) ? 'the destination' : old ? 'left out: over 5 min old and the car may have moved; eta_from_here gives a time from here' : 'where you were then',
    results: s.candidates.map(c => {
      const p = t.places[c.ref]
      return { ref: c.ref, name: p.name, ...(!old && { min: c.min, detour_min: c.detour_min }), rating: p.rating, reviews: p.reviews,
        price: priceSymbol(p.price), open_now: p.open_now, ...(c.asked_for && { asked_for: true }) }
    }),
  }
}

// Trimmed JSON for the system prompt (DESIGN.md "Context sent to the LLM"). Polylines, the full step list, older
// searches and older messages stay out (get_trip_state).
export function buildContext(t: Trip, profile: Note[] = []) {
  const s = t.searches.at(-1)
  const reached = t.plan.filter(e => e.reached_at).map(e => `${named(t, e.ref)} (${e.kind})`)
  const from = t.places[t.origin].name
  return {
    now: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST',
    // A stop logged on a no-destination trip (#3) is a reached entry only: the trip still has no destination.
    trip: t.plan.some(e => e.kind === 'destination' || !e.reached_at) ? {
      from,
      ...(onRoad(t) && { at: onRoad(t) }), // where the car is now; `from` is only where the trip started
      ahead: ahead(t),
      ...(reached.length && { reached }),
      next_steps: nextSteps(t).slice(0, 2).map((x, i) => (i ? x.text : `${x.text} (${x.km} km)`)),
      off_route: offRoute(t),
      ...(arrived(t) && { arrived: true }),
    } : { from, ahead: [], ...(reached.length && { reached }), note: 'No destination set: searches are around the current position. Use from_now.' },
    ...(s && { last_search: searchView(t, s) }),
    cards_shown_earlier: shown(t).map(r => named(t, r)).join(', '), // not the plan (TESTSET #52): the plan is trip.ahead
    notes: t.notes.slice(-20).map(withId),
    profile: profile.map(withId),
  }
}
