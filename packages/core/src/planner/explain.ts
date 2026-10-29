import { DAYS } from './hours.ts'
import { complete, PLANNER_MODELS } from './model.ts'
import type { Itinerary, Stop } from './types.ts'

export const CLOSING_MATTERS = 90 // minutes: mention closing time only when the visit ends within this long of it

export const PROMPT = `Write one plain sentence of at most 22 words giving a specific reason this place suits the stop.
Use only the facts given. Do not invent details and do not use hype words.
Never mention an offer or event limited to certain days or hours, or meant for people the user did not mention,
such as corporate groups.
Lead with the evidence when there is any. Otherwise name one concrete fact, such as the kind of place,
a short travel time, or a late closing time that matters for an evening stop.
Never mention the length of the visit. Mention the rating only if nothing else fits.
Return only the sentence.`

const pad = (n: number) => String(n).padStart(2, '0')

// What the reasons need beyond the stop: the day (claims for other days are dropped) and what the user wants to buy.
// The model is not told the day or time: told, it repeated them in every reason (2026-10-24).
export type Visit = { weekday: number; shop_for?: string }

// The weekdays a claim is limited to (0 = Sunday), or null when it names none. Full day names count anywhere; short
// ones ("Mon") only in a range ("Mon-Thu"), because "sat" and "sun" are also plain words.
export function claimDays(claim: string): Set<number> | null {
  const w = claim.toLowerCase().match(/[a-z]+|[-–—]/g) ?? []
  const day = (x = '', short: boolean) => DAYS.findIndex(d => x === d || x === d + 's' || (short && x.length >= 3 && d.startsWith(x)))
  const days = new Set<number>()
  for (let i = 0; i < w.length; i++) {
    const a = day(w[i], true), b = day(w[i + 2], true)
    if (a >= 0 && b >= 0 && /^([-–—]|to|through|till|until)$/.test(w[i + 1])) {
      for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break }
      i += 2
    } else if (day(w[i], false) >= 0) days.add(day(w[i], false))
    else if (/^weekdays?$/.test(w[i])) [1, 2, 3, 4, 5].forEach(d => days.add(d))
    else if (/^weekends?$/.test(w[i])) [0, 6].forEach(d => days.add(d))
  }
  return days.size ? days : null
}

// The minutes since midnight a claim's time range covers ("4 to 7 pm", "11:30am-3pm", "18:00-20:00"), or null when it
// names none. A range that ends before it starts runs past midnight.
// ponytail: the first range only, and "11-1 pm" reads as 23:00 to 13:00; enough for offer and happy-hour lines.
const RANGE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/
export function claimHours(claim: string): [number, number] | null {
  const m = claim.toLowerCase().match(RANGE)
  if (!m || !(m[3] || m[6] || (m[2] && m[5]))) return null // "2-3 people" is not a time
  const mins = (h: string, mm: string | undefined, ap: string | undefined) => ((ap ? (Number(h) % 12) + (ap === 'pm' ? 12 : 0) : Number(h)) * 60) + Number(mm ?? 0)
  const start = mins(m[1], m[2], m[3] ?? m[6]), end = mins(m[4], m[5], m[6] ?? m[3])
  return [start, end <= start ? end + 1440 : end]
}

// A claim holds for the visit unless it is limited to other weekdays or to hours outside the stay.
export function applies(claim: string, weekday: number, arrive: number, depart: number): boolean {
  const days = claimDays(claim), hours = claimHours(claim)
  return (!days || days.has(weekday)) && (!hours || [0, 1440].some(s => hours[0] + s < depart && arrive < hours[1] + s))
}

// Does the text share a word with what the user wants to buy ("Premium Demi-Fine" and "demi fine ring")?
const mentions = (text: string, want: string) => {
  const ws = text.toLowerCase().split(/[^a-z]+/)
  return want.toLowerCase().split(/[^a-z]+/).some(w => w.length > 3 && ws.some(x => x.startsWith(w)))
}

// The evidence the reason may use: with a visit, only claims that hold for it.
const usable = (stop: Stop, visit?: Visit) =>
  visit ? stop.place.evidence.filter(e => applies(e.claim, visit.weekday, stop.arrive, stop.depart)) : stop.place.evidence

// Python printed a rating of 4 as 4.0; keep the model's input the same.
const rated = (r: number | undefined) => (r === undefined ? 'None' : Number.isInteger(r) ? r.toFixed(1) : String(r))

export function facts(stop: Stop, visit?: Visit): string {
  const p = stop.place
  const lines = [`Stop: ${stop.stop_type}`, `Place: ${p.name}`]
  // Only where the name or the evidence backs it: told for any shop, the model said every shop sold it (2026-10-24).
  const backed = [p.name, ...usable(stop, visit).map(e => e.claim)].join(' ')
  if (visit?.shop_for && stop.stop_type === 'shopping' && mentions(backed, visit.shop_for)) lines.push(`The user wants to buy: ${visit.shop_for}`)
  if (p.type) lines.push(`Kind of place: ${p.type.replaceAll('_', ' ')}`)
  lines.push(`Google rating: ${rated(p.rating)} from ${p.reviews ?? 0} reviews`)
  if (stop.travel_from_prev_min) lines.push(`Travel from the previous stop: ${stop.travel_from_prev_min} minutes`)
  if (stop.closes !== null && stop.closes - stop.depart <= CLOSING_MATTERS) // a far-off closing time says nothing
    lines.push(`Open until ${pad(Math.floor((stop.closes % 1440) / 60))}:${pad(stop.closes % 60)}`)
  for (const e of usable(stop, visit)) lines.push(`Evidence: ${e.claim}`)
  return lines.join('\n')
}

export function fallback(stop: Stop, visit?: Visit): string {
  const p = stop.place, evidence = usable(stop, visit)
  if (evidence.length) return evidence[0].claim
  return p.rating ? `Rated ${rated(p.rating)} from ${p.reviews ?? 0} Google reviews.` : 'No evidence found.'
}

export async function explainStop(stop: Stop, visit?: Visit): Promise<string> {
  try {
    const text = (await complete(PLANNER_MODELS.read, PROMPT, facts(stop, visit), { maxTokens: 200 })).trim()
    return text.split('</think>').at(-1)!.trim().replace(/^"+|"+$/g, '') || fallback(stop, visit)
  } catch {
    return fallback(stop, visit)
  }
}

// Fills Stop.reason for every distinct (place, stop type) across the itineraries, in parallel. The user's own place
// needs no reason: they chose it.
export async function addReasons(itineraries: Itinerary[], visit?: Visit): Promise<void> {
  const unique = new Map<string, Stop>()
  for (const it of itineraries) for (const s of it.stops) {
    if (s.own) continue
    const key = `${s.place.place_id}|${s.stop_type}`
    if (!unique.has(key)) unique.set(key, s)
  }
  const texts = new Map(await Promise.all([...unique].map(async ([key, s]) => [key, await explainStop(s, visit)] as const)))
  for (const it of itineraries) for (const s of it.stops) s.reason = texts.get(`${s.place.place_id}|${s.stop_type}`) ?? ''
}
