import { useEffect, useRef, useState } from 'react'
import { ahead, api, applyFix, arrived, ask, decode, forgotLine, googleProvider, isEmergency, istIso, legsAhead, MODELS, newTrip, offRoute,
  upsertPlaces, withStop, type LatLng, type Message, type Note, type Place, type PlanEntry, type RouteLeg,
  type Suggestion, type Trip } from '@trippy/core'
import { load, remove, save } from './store.ts'
import { fakeTrace, here, play, watchGps, type Trace } from './position.ts'
import { log, startTrip } from './log.ts'

// Tapping a banner sends `ask` to the chat; no model call before the tap (Q31, Q34).
// kind + dest let a banner be checked against the trip each time it is shown (#66): see `current` below.
// late (jump only): the arrival time (ms) before the jump plus JUMP_MIN; a refresh arriving earlier drops it (#A).
export type Banner = { text: string; ask: string; kind?: 'long' | 'jump'; dest?: string; late?: number }

const LONG_MIN = 30 // ponytail: long-ETA threshold picked so the Kurla -> Juhu demo (31-43 min) shows it; tune after real trips
const JUMP_MIN = 20 // Q34
const REFRESH_MS = 5 * 60_000 // route refresh while the app stays open
const OFF_ROUTE_MS = 60_000 // Q18: off the current leg for ~1 min -> new route
const REPLAY_SPEED = Number(new URLSearchParams(location.search).get('replay')) || 10 // ?replay=60 for the E2E runner
const STALE_MS = 60_000 // a live fix older than this: the app was hidden (no GPS there, B1)
const STOP_NAME_M = 150 // a logged stop takes the name of the nearest Google place within this

// What a failed call shows (#9): never the raw error ("TypeError: Failed to fetch" was a chat reply in a tunnel).
export const NO_SIGNAL = 'No signal right now. Please try again in a moment.'
export const noSignal = (e: unknown) => !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed/i.test(String(e))

const unreached = (plan: PlanEntry[]) => plan.filter(e => !e.reached_at)
const refs = (plan: PlanEntry[]) => plan.map(e => e.ref).join() // what the user decided; reached_at is not part of it
const total = (legs: { duration_sec: number }[]) => Math.round(legs.reduce((s, l) => s + l.duration_sec, 0) / 60)
const short = (p: Place) => p.name.split(',')[0]
// A /llm call body -> its MODELS key (rank and plan share Ultra; reasoning tells them apart). An own-key call: its model id.
const tierOf = (b: any) => Object.entries(MODELS).find(([, m]) => m.model === b.model && m.think === b.chat_template_kwargs?.enable_thinking)?.[0] ?? b.model
// A route from a live trip's old fix starts where the car was (#A: ~20 km back once gave a false "ETA now 154 min (+23)").
const stale = (t: Trip) => t.live && Date.now() - Date.parse(t.fix.t) > STALE_MS

// One Compute Routes call from the fix through the given plan entries (Routes intermediates), one leg each.
async function routeVia(t: Trip, plan: PlanEntry[]): Promise<RouteLeg[] | null> {
  const to = unreached(plan)
  if (!to.length) return null
  const where = (ref: string) => { const p = t.places[ref]; return p.place_id ? { placeId: p.place_id } : p.location }
  const legs = await googleProvider.route({ lat: t.fix.lat, lng: t.fix.lng }, to.map(e => where(e.ref)))
  return legs.map((l, i) => ({ to: to[i].ref, ...l }))
}

// The active trip (one IndexedDB document, saved whole), profile notes, and the actions that change them.
// Code writes all state (Q17); computed fields (ahead, arrived, ...) come from @trippy/core on read. No rendering here.
export function useTrip() {
  const [trip, setTrip] = useState<Trip | null>(null)
  const [busy, setBusy] = useState('')
  const [profile, setProfile] = useState<Note[]>([])
  const [banner, setBanner] = useState<Banner | null>(null)
  const [trace, setTrace] = useState<Trace | null>(null) // set while a replay plays
  const [loaded, setLoaded] = useState(false)
  const now = useRef({ trip, trace })
  now.current = { trip, trace }
  const offSince = useRef(0) // off-route timer (in memory only)
  const routeSeq = useRef(0) // only the latest route request is applied (#A)
  const naming = useRef(new Set<string>()) // logged stops whose name was asked for this session

  // Reload keeps everything: state comes back from IndexedDB, then every change is written back. End trip deletes it.
  useEffect(() => {
    Promise.all([load<Trip>('trip'), load<{ notes: Note[] }>('profile')])
      .then(([t, p]) => { if (t) { log('restore', { id: t.id }); setTrip(t); comeBack(t) } if (p) setProfile(p.notes) })
      .finally(() => setLoaded(true))
  }, [])
  useEffect(() => { if (loaded) (trip ? save('trip', trip) : remove('trip')).catch(() => {}) }, [loaded, trip])
  // Screen stays on while a trip is open: the PWA only gets GPS in front (B1), and a screen that times out stops it.
  // The browser drops the lock when the app is hidden, so it is asked for again on return.
  useEffect(() => {
    if (!trip) return
    let lock: WakeLockSentinel | undefined
    const ask = () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').then(l => { lock = l }).catch(() => {}) }
    ask()
    document.addEventListener('visibilitychange', ask)
    return () => { document.removeEventListener('visibilitychange', ask); lock?.release().catch(() => {}) }
  }, [!!trip])
  useEffect(() => { if (loaded) save('profile', { notes: profile }) }, [loaded, profile])
  // Debug log: a banner shown, and the state after every turn (busy goes back to '' once the trip is updated).
  useEffect(() => { if (banner) log('banner', banner) }, [banner])
  useEffect(() => { if (loaded && !busy && trip) log('state', { trip, profile }) }, [busy])

  // New route from the fix through every unreached plan entry. Dropped if a newer request went out (two at once on
  // return from the background, #A) or the user changed the plan meanwhile (that change has its own call on the way);
  // an entry reached meanwhile is fine (its leg just drops out of legsAhead).
  // jump: compare with what the old route still had left (Q34); not after a plan change, where the time is expected,
  // and never from a stale fix. A jump banner stays while fresh routes still arrive JUMP_MIN later than before it.
  async function reroute(t: Trip, jump = false) {
    const id = ++routeSeq.current
    const route = await routeVia(t, t.plan).catch(e => { log('error', { reroute: String(e) }); return undefined })
    const cur = now.current.trip
    if (route === undefined || id !== routeSeq.current || !cur || refs(cur.plan) !== refs(t.plan)) return
    const before = ahead(cur).at(-1)?.min
    setTrip(x => (x && refs(x.plan) === refs(t.plan) ? { ...x, route } : x))
    if (now.current.trace && route) setTrace(fakeTrace(route)) // replay follows the new route from here
    const min = route ? total(route) : 0, up = before == null ? 0 : min - before
    const dest = t.places[unreached(t.plan).at(-1)?.ref ?? '']
    if (stale(t)) return
    if (jump && dest && up >= JUMP_MIN) setBanner({ kind: 'jump', dest: unreached(t.plan).at(-1)?.ref, text: `ETA now ${min} min (+${up}). Still worth it?`,
      ask: `Traffic got worse: now ${min} min to ${short(dest)}. Still worth going, or something similar closer?`, late: Date.now() + (before! + JUMP_MIN) * 60_000 })
    else setBanner(b => (b?.kind === 'jump' && Date.now() + min * 60_000 < b.late! ? null : b))
  }

  // Plan changes (Add stop, ✕, Where next?) write the plan, then a fresh route.
  function setPlan(plan: PlanEntry[], places?: Trip['places']) {
    const t = now.current.trip
    if (!t) return
    const next = { ...t, plan, places: places ?? t.places }
    setTrip(x => x && { ...x, plan, places: next.places })
    reroute(next)
  }

  // The one entry point for positions, from live GPS or replay (applyFix: live rule, reached_at at ~100 m).
  const move = ({ acc, ...p }: LatLng & { acc?: number }, src: 'gps' | 'replay') => {
    log('position', { ...p, acc, src }) // acc only in the log, never in the trip
    setTrip(t => t && applyFix(t, p, src === 'gps'))
  }

  // Off-route (Q18): ~300 m off the current leg for ~1 min -> one new route.
  useEffect(() => {
    if (!trip || !offRoute(trip)) { offSince.current = 0; return }
    if (!offSince.current) offSince.current = Date.now()
    else if (Date.now() - offSince.current >= OFF_ROUTE_MS) { offSince.current = 0; log('off_route'); reroute(trip, true) }
  }, [trip?.fix])

  // A logged stop (applyFix, #3) is named after the nearest Google place: one Nearby Search per stop.
  // Nothing there, or no signal until the trip ends: it keeps "Stop at HH:MM".
  useEffect(() => {
    for (const e of trip?.plan ?? []) {
      const p = trip!.places[e.ref], key = trip!.id + e.ref
      if (e.kind !== 'stop' || p.place_id || naming.current.has(key)) continue
      naming.current.add(key)
      googleProvider.nearest(p.location, STOP_NAME_M).then(n => {
        log('stop_logged', { ref: e.ref, at: e.reached_at, name: n?.name ?? null })
        if (n) setTrip(x => (x?.id === trip!.id ? { ...x, places: { ...x.places, [e.ref]: { ...x.places[e.ref], ...n } } } : x))
      }).catch(err => { naming.current.delete(key); log('error', { stop_name: String(err) }) }) // asked again at the next plan change
    }
  }, [trip?.plan])

  // One position source at a time: the replay while it plays, otherwise live GPS.
  const active = !!trip
  useEffect(() => {
    if (!active) return
    if (trace) return play(trace, REPLAY_SPEED, p => move(p, 'replay'), () => { log('replay', { on: false, ended: true }); setTrace(null) })
    return watchGps(p => move(p, 'gps'))
  }, [active, trace])

  // B1: on return to the app and on reload, a fresh position (when live) and one route call; every 5 min while open.
  async function comeBack(t = now.current.trip) {
    if (!t) return
    const p = t.live && !now.current.trace ? await here().catch(() => null) : null
    if (p) { move(p, 'gps'); t = applyFix(t, p, true) }
    reroute(t, true)
  }
  useEffect(() => {
    if (!active) return
    const onShow = () => document.visibilityState === 'visible' && comeBack()
    document.addEventListener('visibilitychange', onShow)
    const id = setInterval(() => document.visibilityState === 'visible' && now.current.trip && reroute(now.current.trip, true), REFRESH_MS)
    return () => { document.removeEventListener('visibilitychange', onShow); clearInterval(id) }
  }, [active])

  function begin(t: Trip | null) {
    setTrip(t)
    setTrace(null)
    setBanner(null)
  }

  // Start from two picked suggestions (place ids, never a guessed address). Origin and destination sit where Google's
  // route starts and ends; the fix starts at the origin. True when the trip started.
  async function start(from: Suggestion, to: Suggestion) {
    setBusy('Finding route…')
    startTrip({ from: from.main, to: to.main, fromId: from.placeId, toId: to.placeId })
    try {
      const [leg] = await googleProvider.route({ placeId: from.placeId }, [{ placeId: to.placeId }])
      const pts = decode(leg.polyline)
      // Full "name, area" so the model knows where the destination is (it once guessed a Fort gallery was in Powai).
      const place = (s: Suggestion, location: LatLng): Place => ({ place_id: s.placeId, name: `${s.main}, ${s.secondary}`, location })
      const t = newTrip(place(from, pts[0]), place(to, pts.at(-1)!), leg)
      begin(t)
      const min = total([leg])
      if (min >= LONG_MIN) setBanner({ kind: 'long', dest: unreached(t.plan).at(-1)?.ref, text: `${min} min to ${to.main}. Something similar, closer?`,
        ask: `It's ${min} min to ${to.main}. Anything similar closer, within 20 min?` })
      return true
    } catch (e) {
      log('error', { start: String(e) })
      return false
    } finally {
      setBusy('')
    }
  }

  // No destination (G2): a live trip at the current GPS position, empty plan, no route. True when it started.
  async function startHere() {
    setBusy('Finding you…')
    startTrip({ from: 'Current location', to: '' })
    try {
      begin(newTrip({ place_id: null, name: 'Current location', location: await here() }))
      return true
    } catch {
      return false
    } finally {
      setBusy('')
    }
  }

  // From an accepted outing plan (Plan an outing): from the current location through every outing stop in order, the
  // last one the destination. Location off: starts at the first stop, live once GPS gets there (as Start). True when started.
  async function startPlan(stops: Place[]) {
    setBusy('Finding route…')
    startTrip({ from: 'Current location', to: stops.at(-1)?.name, plan: stops.map(s => s.place_id) })
    try {
      const p = await here().catch(() => null)
      const t = newTrip(p ? { place_id: null, name: 'Current location', location: p } : stops[0])
      const { places, refs } = upsertPlaces(t.places, p ? stops : stops.slice(1))
      const plan = refs.map((ref, i): PlanEntry => ({ ref, kind: i === refs.length - 1 ? 'destination' : 'stop', reached_at: null }))
      begin({ ...t, plan, places, route: await routeVia({ ...t, places }, plan) })
      return true
    } catch (e) {
      log('error', { start_plan: String(e) })
      return false
    } finally {
      setBusy('')
    }
  }

  // "I'm here, use my location": live GPS takes over from now on; route from the real position.
  async function imHere() {
    const t = now.current.trip
    if (!t) return
    const p = await here().catch(() => null)
    if (!p) return
    const next = applyFix({ ...t, live: true }, p, true)
    log('im_here', p)
    setTrip(x => x && applyFix({ ...x, live: true }, p, true))
    reroute(next)
  }

  // Replay (H3): drive the road still ahead through the GPS watcher. Fake trace until the recorded one exists.
  // ponytail: starts where the current leg starts (the fix of the last route refresh), at most ~5 min behind the fix.
  const replay = () => {
    const legs = trip ? legsAhead(trip) : []
    const on = !trace && legs.length > 0
    log('replay', { on })
    setTrace(on ? fakeTrace(legs) : null)
  }

  // True when the model heard "end the trip" (C): the app then opens the End-trip confirm.
  async function send(text: string): Promise<boolean> {
    const t = now.current.trip
    if (!t || busy) return false
    log('send', { text })
    const said: Message = { role: 'user', text, ...(isEmergency(text) && { sos: true as const }) } // 112 button (Q35)
    setTrip(x => x && { ...x, messages: [...x.messages, said] })
    setBusy('Thinking…')
    let reply: Message
    let end = false
    let gone: Message[] = [] // "Forgot: ..." lines for the notes the model deleted this turn
    // "How Trippy decided": model calls seen on the call hook (only the agent calls /llm on a trip); map calls counted on the
    // provider the agent gets, so a route refresh meanwhile is not counted.
    const t0 = Date.now(), models: string[] = [], hook = api.onCall
    let maps = 0
    api.onCall = e => { hook?.(e); const b = e.body as any; if (b?.messages) models.push(tierOf(b)) }
    const p = new Proxy(googleProvider, { get: (o: any, k) => typeof o[k] === 'function' ? (...x: any[]) => (maps++, o[k](...x)) : o[k] })
    try {
      const a = await ask(p, t, text, s => { log('step', { text: s }); setBusy(s) }, profile)
      log('answer', a) // text, tool steps, memory ops, search, link
      // Code applies all state changes; the model only asked for them via remember / forget (Q17).
      const { add, remove } = a.memory
      // A deadline replaced by a newer one goes quietly: no "Forgot:" line for it.
      gone = [...profile, ...t.notes].filter(n => remove.includes(n.id) && !n.text.startsWith('Deadline:')).map(n => forgotLine(n.text))
      const kept = (ns: Note[], scope: 'trip' | 'profile') =>
        [...ns.filter(n => !remove.includes(n.id)), ...add.filter(n => n.scope === scope).map(({ id, text }) => ({ id, text }))]
      setProfile(ps => kept(ps, 'profile'))
      // Functional update: the fix may have moved while the model was thinking.
      // ponytail: places merge by ref; a "Where next?" during a turn could take the same new ref. Controls wait on busy.
      setTrip(x => x && { ...x, notes: kept(x.notes, 'trip'), places: { ...x.places, ...a.places },
        searches: a.search ? [...x.searches, a.search] : x.searches })
      reply = { role: 'assistant', text: a.text, ...(a.search && { search: a.search.id }), ...(a.link && { link: a.link }),
        how: { ms: Date.now() - t0, models, maps, steps: a.steps } }
      end = !!a.end
    } catch (e) {
      log('error', { turn: text, message: String(e) })
      reply = { role: 'assistant', text: noSignal(e) ? NO_SIGNAL : 'Sorry, something went wrong there. Please try again.' }
    } finally {
      api.onCall = hook
    }
    setTrip(x => x && { ...x, messages: [...x.messages, ...gone, reply] })
    setBusy('')
    return end
  }

  // Add stop preview: a route via the card's place, drawn with "+N min" and never stored. N is against a route without
  // the stop fetched at the same moment: the stored route's traffic can be minutes old (a stale one once gave "+-4").
  // A failed call throws (logged): the caller tells no signal from no route.
  async function previewStop(ref: string): Promise<{ legs: RouteLeg[]; plusMin: number } | null> {
    const t = now.current.trip
    if (!t) return null
    const [legs, without] = await Promise.all([routeVia(t, withStop(t.plan, ref)), routeVia(t, t.plan)])
      .catch(e => { log('error', { preview_stop: String(e) }); throw e })
    if (!legs) return null
    log('preview_stop', { ref })
    // Google's route via a nearby stop can come out faster than its direct one (seen: -3 min); that costs nothing: +0.
    return { legs, plusMin: Math.max(0, total(legs) - total(without ?? [])) }
  }
  const confirmStop = (ref: string) => { log('confirm_stop', { ref }); if (trip) setPlan(withStop(trip.plan, ref)) }
  const removeStop = (ref: string) => { log('remove_stop', { ref }); if (trip) setPlan(trip.plan.filter(e => e.ref !== ref)) }

  // "Where next?": a new destination at the end of the plan (Q25); chat, notes, places and searches carry over.
  // Its location is where Google's route ends, as at Start, so this route call is also the plan's fresh route.
  async function whereNext(s: Suggestion) {
    const t = now.current.trip
    if (!t || busy) return
    setBusy('Finding route…')
    log('where_next', { to: s.main, id: s.placeId })
    try {
      const { places, refs: [ref] } = upsertPlaces(t.places, [{ place_id: s.placeId, name: `${s.main}, ${s.secondary}`, location: t.fix }])
      const plan = [...t.plan, { ref, kind: 'destination' as const, reached_at: null }]
      const route = (await routeVia({ ...t, places }, plan))! // routes by place id
      places[ref] = { ...places[ref], location: decode(route.at(-1)!.polyline).at(-1)! }
      setTrip(x => x && { ...x, plan, places, route })
      if (now.current.trace) setTrace(fakeTrace(route))
      return true
    } catch (e) {
      log('error', { where_next: String(e) })
      return false
    } finally {
      setBusy('')
    }
  }

  // End trip deletes the document (the debug log keeps its copy) and returns to the landing screen.
  const endTrip = () => { log('end_trip', { id: trip?.id, at: istIso() }); begin(null) }

  // A banner shows only while it is still true (#66): gone on arrival, after the destination changes, or once a 112
  // message is on screen. The long-ETA one shows the minutes left now and goes once they drop under LONG_MIN.
  const current = ((): Banner | null => {
    if (!banner || !trip || arrived(trip) || trip.messages.some(m => m.sos)) return null
    if (banner.dest && banner.dest !== unreached(trip.plan).at(-1)?.ref) return null
    if (banner.kind !== 'long') return banner
    const min = ahead(trip).at(-1)?.min
    if (min == null || min < LONG_MIN) return null
    const now = (s: string) => s.replace(/\d+ min/, `${min} min`)
    return { ...banner, text: now(banner.text), ask: now(banner.ask) }
  })()

  const tapBanner = () => { if (!current || busy) return; log('banner_tap', current); send(current.ask); setBanner(null) }

  // Profile screen delete (G3): code removes the note, same as forget(). The deletion is also a chat line: the model reads
  // the last 10 messages, where an old line may still quote the note (TESTSET #54), and the user sees it too.
  const forget = (id: string) => {
    const n = profile.find(n => n.id === id)
    setProfile(ps => ps.filter(n => n.id !== id))
    if (n) setTrip(x => x && { ...x, messages: [...x.messages, forgotLine(n.text)] })
  }

  return { trip, live: !!trip?.live, ahead: trip ? ahead(trip) : [], arrived: !!trip && arrived(trip), busy, banner: current,
    replaying: !!trace, profile, start, startHere, send, replay, imHere, previewStop, confirmStop, removeStop, whereNext,
    endTrip, forget, tapBanner, dismissBanner: () => setBanner(null), startPlan }
}
