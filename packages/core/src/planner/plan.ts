// End to end: constraints in, itineraries out. Places and travel times come from Google, the search is plain code
// (search.ts), and the model only reads evidence and writes the one-line reasons.
import { enrich } from './enrich.ts'
import { addReasons } from './explain.ts'
import { parseWeekday } from './hours.ts'
import { findCandidates, findPlace, geocode, legMinutes, nextDeparture } from './places.ts'
import { at, buildItineraries, DWELL, closedBlocker, explainRejection, firstShiftThatFits, suggestRelaxations } from './search.ts'
import { nextDate, sunsetMinutes } from './sun.ts'
import { stopWants } from './types.ts'
import type { Constraints, LatLng, PlanResult } from './types.ts'

export class UnknownArea extends Error {}

const IST = 330 * 60_000
// Sunday-based weekday in IST, whatever the device's time zone.
const istWeekday = (now: Date) => new Date(now.getTime() + IST).getUTCDay()
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

// "I can't plan a movie or bowling yet, so I planned the rest." done = 'will plan' before planning.
export const cannotPlan = (what: string[], done = 'planned') =>
  `I can't plan ${what.length > 1 ? what.slice(0, -1).join(', ') + ' or ' + what.at(-1) : what[0]} yet, so I ${done} the rest.`

export type PlanOptions = {
  near?: LatLng // biases the area lookup (the user's position, when known)
  web?: boolean // false = no web evidence (tests, or when the search allowance is spent)
  reasons?: boolean // false = skip the model-written reasons
  radiusM?: number
  n?: number
  now?: Date
  onStep?: (step: string) => void // progress for the screen
}

export async function plan(c: Constraints, opts: PlanOptions = {}): Promise<PlanResult> {
  const { near, web = true, reasons = true, radiusM = 1500, n = 8, now = new Date(), onStep = () => {} } = opts
  onStep('Finding the area')
  const area = await geocode(c.area.trim(), near)
  if (!area) throw new UnknownArea(`I couldn't find '${c.area}'. Check the spelling or try a nearby neighbourhood.`)
  const weekday = parseWeekday(c.day, istWeekday(now))
  const startMin = toMin(c.start_time)

  onStep('Finding places')
  // A place the user named is that stop's only candidate: looked up by name, never searched for or swapped.
  const named = c.stops.map((t, i) => (c.stops.indexOf(t) === i ? c.named_places?.find(p => p.stop === t) : undefined))
  const own = await Promise.all(named.map(p => (p ? findPlace(p.name, area.location) : null)))
  const candidates = await Promise.all(c.stops.map((t, i) =>
    own[i] ? [own[i]!] : findCandidates(t, area.location, radiusM, n, t === 'shopping' ? c.shop_for || undefined : undefined)))
  // What we tell the user we did not do as asked, before anything else.
  const notes = [...(c.unsupported?.length ? [cannotPlan(c.unsupported)] : []),
    ...named.flatMap((p, i) => (p && !own[i] ? [`I couldn't find ${p.name} near ${area.name}, so I picked other ${p.stop} places.`] : []))]
  const result = (r: Omit<PlanResult, 'area_name'>): PlanResult => {
    for (const it of r.itineraries) it.warnings.unshift(...notes)
    return { ...r, message: r.message && [...notes, r.message].join(' '), area_name: area.name }
  }
  const empty = c.stops.filter((_, i) => !candidates[i].length)
  if (empty.length) return result({ itineraries: [], message: `No places found near ${c.area} for: ${empty.join(', ')}.`, options: [] })
  // The first named place with a time sets the clock: the other stops are planned around it.
  // ponytail: one set time per outing; a second named time is ignored (its place is still the stop). Add more if asked.
  const f = named.findIndex(p => p?.time)
  const fixed = f >= 0 ? { stop: f, at: toMin(named[f]!.time), own: !!own[f] } : undefined
  // With a set time and no length given, the length is what the stops need: an assumed total must not cut them short.
  const duration = fixed && c.assumed.includes('duration_minutes')
    ? Math.max(c.duration_minutes, c.stops.reduce((m, t) => m + (c.stay_minutes[t] || DWELL[t]), 0) + c.max_travel_minutes * (c.stops.length - 1))
    : c.duration_minutes

  onStep('Reading what people say about them')
  await enrich(candidates, c, web)

  onStep('Checking travel times')
  const departure = nextDeparture(weekday, fixed?.at ?? startMin, now) // ponytail: traffic at the set time, not the worked-out start
  const legs = await Promise.all(c.stops.slice(0, -1).map((_, i) => legMinutes(candidates[i], candidates[i + 1], departure)))

  onStep('Checking hours and building the plan')
  const sunset = sunsetMinutes(area.location, nextDate(weekday, now))
  const search = (start: number) => buildItineraries({
    stop_types: c.stops, candidates, legs, weekday, start_min: start, duration,
    max_travel: c.max_travel_minutes, must_haves: c.must_haves, sunset_min: sunset, stay: c.stay_minutes, budget: c.budget,
    ...(fixed && { fixed }), ...(c.shop_for && { stop_wants: c.stops.map(t => stopWants(t, c)) }),
  })
  let { itineraries, rejected } = search(startMin)
  // Everything closed at that hour: try nearby start times and say that we moved it. A set time leaves nothing to move.
  if (!itineraries.length && rejected.closed && !fixed) {
    const shifted = firstShiftThatFits(start => search(start).itineraries, startMin)
    if (shifted) {
      itineraries = shifted.found
      let note = `Moved your start from ${at(startMin)} to ${at(shifted.start)} because every ${closedBlocker(rejected)} option was closed at ${at(startMin)}.`
      if (c.assumed.includes('start_time')) note += ' You did not give a start time, so tell me when you want to go to choose your own.'
      for (const it of itineraries) it.warnings.unshift(note)
    }
  }
  if (!itineraries.length) return result({
    itineraries: [],
    message: explainRejection(rejected, c.stops, candidates, weekday, c),
    rejected,
    options: suggestRelaxations(rejected, c.max_travel_minutes, startMin).filter(o => !(fixed && o.change.start_time)),
  })
  for (const it of itineraries) it.stops.forEach((s, i) => { if (own[i]) s.own = true })
  // A start the user gave that the set time moves. The parser sometimes copies the named place's time into start_time:
  // that is not a start.
  if (fixed && !c.assumed.includes('start_time') && startMin !== fixed.at) {
    const name = candidates[fixed.stop][0].name
    for (const it of itineraries) if (it.start_min !== startMin) it.warnings.unshift(it.start_min < startMin
      ? `The stops before ${name} do not fit between ${at(startMin)} and ${at(fixed.at)}, so this plan starts at ${at(it.start_min)}.`
      : `Start moved to ${at(it.start_min)} to reach ${name} at ${at(fixed.at)}.`)
  }
  if (reasons) {
    onStep('Writing the reasons')
    await addReasons(itineraries, { weekday, shop_for: c.shop_for })
  }
  return result({ itineraries, message: '', rejected, options: [] })
}
