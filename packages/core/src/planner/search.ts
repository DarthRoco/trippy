// The itinerary search: every combination of candidates, timed, checked against opening hours and scored. Plain code,
// no model. Ported from the Python planner's search.py; search.check.ts holds it to the same answers.
import { closingTime, isOpen, windows } from './hours.ts'
import { INHERENT } from './types.ts'
import type { Budget, Constraints, Itinerary, PlannerPlace, Rejected, Relaxation, SearchInput, Stop, StopType } from './types.ts'

export const DWELL: Record<StopType, number> = { coffee: 45, work: 60, sunset: 45, dinner: 75, lunch: 60, snack: 30, walk: 45, bar: 60, shopping: 45 }
export const MIN_DWELL = 20
export const SHORTEN_WARN = 10 // warn only when a named stay loses at least this many minutes
export const UNKNOWN_FACTOR = 0.5 // an unverified want costs half of what a refuted one does
export const SUNSET_LEAD = 30 // minutes before sunset to arrive
export const SUNSET_GRACE = 15 // a walk may run this long past sunset before it counts as after dark
export const DARK_PENALTY = 1.0 // score lost per after-dark walk, so daylight walks rank first
export const MAX_SHIFT = 150 // largest start-time move allowed to reach sunset
// Usual hours for a meal stop. A meal outside them is kept but flagged and ranked lower, like an after-dark walk.
export const MEAL_HOURS: Partial<Record<StopType, [number, number]>> = { lunch: [11 * 60 + 30, 15 * 60 + 30], dinner: [18 * 60, 23 * 60 + 30] }
export const OFF_HOURS_PENALTY = 1.0
// Budget: Google's price levels, and the highest level each budget takes without a penalty. An unknown price costs nothing.
const PRICE_RANK: Record<string, number> = { FREE: 0, INEXPENSIVE: 1, MODERATE: 2, EXPENSIVE: 3, VERY_EXPENSIVE: 4 }
const BUDGET_MAX: Record<Budget, number> = { low: 1, medium: 3, high: 4 }
export const BUDGET_PENALTY = 0.5 // score lost per price level over the budget

type Stay = Partial<Record<StopType, number>>
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
export const mins = (n: number) => `${n} minute${n === 1 ? '' : 's'}`

// Minutes since midnight as "HH:MM". Floors like Python's // so a start before midnight reads the same there and here.
export function at(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(minutes / 60))}:${pad(((minutes % 60) + 60) % 60)}`
}

// A place's open windows on one weekday, "10:00 to 15:00 and 18:00 to 23:00"; '' when closed all day or unknown.
const openHours = (open: PlannerPlace['open'], weekday: number) => windows(open, weekday).map(([a, b]) => `${at(a)} to ${at(b)}`).join(' and ')

// Minutes at each stop. Stays are preferences: defaults shrink first, then named stays, until all fit. null = no room.
function dwellMinutes(types: StopType[], travelTotal: number, duration: number, stay: Stay): number[] | null {
  const base = types.map(t => stay[t] || (DWELL[t] ?? 45))
  const room = duration - travelTotal
  if (room < MIN_DWELL * base.length) return null
  if (sum(base) <= room) return base
  const all = base.map((_, i) => i)
  const flex = all.filter(i => !stay[types[i]])
  const fixed = sum(all.filter(i => stay[types[i]]).map(i => base[i]))
  const spare = flex.length > 0 && fixed + MIN_DWELL * flex.length <= room // the named stays fit whole
  const share = spare ? (room - fixed) / sum(flex.map(i => base[i])) : room / sum(base)
  // trunc, not round: Python's int() drops the fraction
  for (const i of spare ? flex : all) base[i] = Math.max(MIN_DWELL, Math.trunc(base[i] * share))
  return base
}

// Average rating, plus evidence for what the user wants, minus travel. No evidence ranks below evidence.
// Ratings are added one by one; Python's sum() also carries the rounding error along, so with three or more stops a
// score can differ from Python's in its last digit, and plans that tie exactly on paper can then swap places.
function fitScore(places: PlannerPlace[], types: StopType[], mustHaves: string[], travelTotal: number, budget?: Budget, extra: string[][] = []): number {
  let score = sum(places.map(p => p.rating || 3.5)) / places.length // || : a rating of 0 is a missing rating
  const cap = budget ? BUDGET_MAX[budget] : 4
  for (const p of places) score -= BUDGET_PENALTY * Math.max(0, (PRICE_RANK[p.price ?? ''] ?? 0) - cap)
  const asked = new Set(mustHaves.map(w => w.toLowerCase()))
  places.forEach((p, i) => {
    const mine = new Set([...asked, ...(extra[i] ?? [])])
    for (const want of new Set([...mine, ...(INHERENT[types[i]] ?? [])])) {
      const weight = mine.has(want) ? 1 : 0.5 // what a stop needs by its nature counts half
      const value = p.attributes[want]
      score += value === true ? weight : value === false ? -weight : -weight * UNKNOWN_FACTOR
    }
  })
  return score - travelTotal / 60
}

// Search all combinations. Returns the best itineraries and a count of why the others were rejected.
export function buildItineraries(input: SearchInput): { itineraries: Itinerary[]; rejected: Rejected } {
  const { stop_types: types, candidates, legs, weekday, start_min: startMin, duration, max_travel: maxTravel } = input
  const mustHaves = input.must_haves ?? [], top = input.top ?? 3, sunset = input.sunset_min ?? null, stay = input.stay ?? {}, fixed = input.fixed
  const results: Itinerary[] = []
  const rejected: Rejected = { too_far: 0, closed: 0, over_time: 0, duplicate: 0, sunset_timing: 0, closed_by: {} }
  const n = types.length
  const sizes = types.map((_, i) => candidates[i].length)
  const total = sizes.reduce((a, b) => a * b, 1)
  for (let k = 0; k < total; k++) {
    // k's digits pick one candidate per stop, the last stop changing fastest (the order of Python's itertools.product).
    // The order matters: equal scores keep it.
    const combo = sizes.map(() => 0)
    for (let i = n - 1, r = k; i >= 0; i--) {
      combo[i] = r % sizes[i]
      r = Math.floor(r / sizes[i])
    }
    const places = combo.map((c, i) => candidates[i][c])
    if (new Set(places.map(p => p.place_id)).size < n) {
      rejected.duplicate++
      continue
    }
    const travel = [0]
    for (let i = 0; i < n - 1; i++) {
      const m = legs[i]?.[combo[i]]?.[combo[i + 1]]
      if (m == null || m > maxTravel) break // no route counts as too far
      travel.push(m)
    }
    if (travel.length < n) {
      rejected.too_far++
      continue
    }
    const travelTotal = sum(travel)
    const dwell = dwellMinutes(types, travelTotal, duration, stay)
    if (!dwell) {
      rejected.over_time++
      continue
    }
    const warnings: string[] = []
    types.forEach((t, i) => {
      const named = stay[t]
      if (named && dwell[i] <= named - SHORTEN_WARN) warnings.push(`Shortened the ${t} stay from ${named} to ${mins(dwell[i])} to fit your time`)
    })
    let begin = startMin
    const sunsetStop = types.indexOf('sunset')
    // A stop with a set time: work back from it, as for sunset, so the stops before it end in time to get there.
    if (fixed) begin = fixed.at - sum(travel.slice(0, fixed.stop + 1)) - sum(dwell.slice(0, fixed.stop))
    else if (sunset != null && sunsetStop >= 0) {
      // Arrive at the sunset stop SUNSET_LEAD minutes before sunset, moving the start if needed.
      begin = sunset - SUNSET_LEAD - sum(travel.slice(0, sunsetStop + 1)) - sum(dwell.slice(0, sunsetStop))
      if (Math.abs(begin - startMin) > MAX_SHIFT) {
        rejected.sunset_timing++
        continue
      }
      if (begin !== startMin) warnings.push(`Start moved to ${at(begin)} to reach the sunset spot before sunset`)
    }
    const stops: Stop[] = []
    let t = begin, dark = 0, offHours = 0
    for (let i = 0; i < n; i++) {
      const p = places[i], type = types[i]
      t += travel[i]
      const arrive = t, depart = t + dwell[i]
      const state = isOpen(p.open, weekday, arrive, depart)
      if (type === 'walk' && sunset != null && depart > sunset + SUNSET_GRACE) {
        warnings.push(`The walk at ${p.name} runs after dark`)
        dark++
      }
      const meal = MEAL_HOURS[type]
      if (meal && (arrive < meal[0] || arrive > meal[1])) {
        warnings.push(`The ${type} stop at ${p.name} starts at ${at(arrive)}, outside usual ${type} hours (${at(meal[0])} to ${at(meal[1])})`)
        offHours++
      }
      const ownAtItsTime = fixed?.own && fixed.stop === i // the user's place at the user's time: say it, do not refuse it
      if (state === false && !ownAtItsTime) {
        rejected.closed_by[type] = (rejected.closed_by[type] ?? 0) + 1
        rejected.closed++
        break
      }
      // unknown hours: keep the place, say so on the stop and on the plan
      const hours = state === false ? openHours(p.open, weekday) : ''
      const stopWarn = state === null ? [`Hours for ${p.name} unknown; not used for timing`]
        : state === false ? [`${p.name} may be closed during your visit, ${at(arrive)} to ${at(depart)}. Google lists it ${hours ? `open ${hours}` : 'closed all day'} that day.`]
        : []
      warnings.push(...stopWarn)
      stops.push({ stop_type: type, place: p, arrive, depart, travel_from_prev_min: travel[i], warnings: stopWarn, reason: '', closes: closingTime(p.open, weekday, arrive) })
      t = depart
    }
    if (stops.length < n) continue // a stop was closed
    results.push({ stops, total_minutes: t - begin, score: fitScore(places, types, mustHaves, travelTotal, input.budget, input.stop_wants) - DARK_PENALTY * dark - OFF_HOURS_PENALTY * offHours, warnings, start_min: begin })
  }
  // Best first. sort is stable, so equal scores stay in the order they were generated, as in Python.
  results.sort((a, b) => b.score - a.score)
  return { itineraries: results.slice(0, top), rejected }
}

// Up to three options for the reasons that actually rejected combinations, most common first.
export function suggestRelaxations(rejected: Rejected, maxTravel: number, startMin: number): Relaxation[] {
  const earlier = at(Math.max(startMin - 60, 0)), later = at(Math.min(startMin + 60, 22 * 60))
  const fixes: Record<'too_far' | 'closed' | 'over_time', Relaxation[]> = {
    too_far: [10, 20].map(d => ({ label: `Allow ${mins(maxTravel + d)} between stops`, change: { max_travel_minutes: maxTravel + d } })),
    closed: [
      { label: `Start an hour earlier, at ${earlier}`, change: { start_time: earlier } },
      { label: `Start an hour later, at ${later}`, change: { start_time: later } },
    ],
    over_time: [{ label: 'Allow 30 more minutes in total', change: { duration_extra: 30 } }],
  }
  const reasons = (['too_far', 'closed', 'over_time'] as const).filter(r => rejected[r]).sort((a, b) => rejected[b] - rejected[a])
  return reasons.flatMap(r => fixes[r]).slice(0, 3)
}

// The stop type whose places were closed most often (the first one counted wins a tie).
export function closedBlocker(rejected: Rejected): StopType | null {
  let best: StopType | null = null
  for (const [type, count] of Object.entries(rejected.closed_by ?? {}) as [StopType, number][])
    if (best === null || count > rejected.closed_by[best]!) best = type
  return best
}

// Try nearby start times, nearest first. The first start whose search finds anything wins; null if none does.
export function firstShiftThatFits<T>(search: (start: number) => T[], startMin: number, deltas = [-60, 60, -120, 120]): { found: T[]; start: number } | null {
  for (const delta of deltas) {
    const start = startMin + delta
    if (start < 0 || start > 22 * 60) continue
    const found = search(start)
    if (found.length) return { found, start }
  }
  return null
}

// What to ask the user, by the reason nothing fit: [constraint field, what it means].
const ASK = {
  closed: ['start_time', 'when you want to go'],
  sunset_timing: ['start_time', 'when you want to go'],
  too_far: ['max_travel_minutes', 'how far you will travel between stops'],
  over_time: ['duration_minutes', 'how long you have'],
} as const
type Reason = keyof typeof ASK

// Say why nothing fit, and ask for a detail we had to assume when it matters.
export function explainRejection(
  rejected: Rejected, stopTypes: StopType[], candidates: PlannerPlace[][], weekday: number,
  c: Pick<Constraints, 'assumed' | 'start_time' | 'max_travel_minutes' | 'duration_minutes'>,
): string {
  // the most common reason; the first listed wins a tie
  const top = (Object.keys(ASK) as Reason[]).reduce((best, r) => ((rejected[r] ?? 0) > (rejected[best] ?? 0) ? r : best))
  if (!rejected[top]) return 'No combination of places fit your request.'
  let why: string
  if (top === 'closed') {
    const blocked = closedBlocker(rejected)!
    const place = candidates[stopTypes.indexOf(blocked)][0]
    const hours = openHours(place.open, weekday) || 'not at all'
    why = `Every ${blocked} option was closed when you would be there. The top-rated one, ${place.name}, is open ${hours} that day.`
  } else {
    why = {
      too_far: `The places for your stops are more than ${mins(c.max_travel_minutes)} apart.`,
      over_time: `Your stays and travel add up to more than ${mins(c.duration_minutes)}.`,
      sunset_timing: 'The sunset stop cannot be reached in time without moving your start by more than two and a half hours.',
    }[top]
  }
  const [field, meaning] = ASK[top]
  if (c.assumed.includes(field)) why += ` You did not say ${meaning}, so I assumed ${c[field]}. Tell me ${meaning} and I will use that.`
  return why
}
