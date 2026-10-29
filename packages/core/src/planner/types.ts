// Outing planner: plan a timed, multi-stop outing before leaving. Independent of the trip feature: it shares the
// relay, the map and the Place shape, and nothing else. Ported from the Python planner (bangalore-outing-planner).
import type { LatLng, Place } from '../types.ts'

export const STOP_TYPES = ['coffee', 'work', 'sunset', 'dinner', 'lunch', 'snack', 'walk', 'bar', 'shopping'] as const
export type StopType = (typeof STOP_TYPES)[number]
export type Budget = 'low' | 'medium' | 'high'
// What a stop type needs by its nature, checked like a must-have at half weight (search) and looked up (enrich).
export const INHERENT: Partial<Record<StopType, string[]>> = {
  work: ['good for working'],
  sunset: ['good sunset view'],
  walk: ['pleasant to walk'],
}

// A place the user named ("dinner at Toit at 8pm"): that exact Google place is the stop. time = HH:MM, '' = not given.
export type NamedPlace = { name: string; stop: StopType; time: string }

// What the parser reads from the request. assumed = fields the user did not state (filled with a default).
export type Constraints = {
  duration_minutes: number
  start_time: string // HH:MM, 24-hour, IST
  day: string // a weekday name or 'today'
  area: string
  stops: StopType[] // in the user's order
  max_travel_minutes: number
  budget: Budget
  stay_minutes: Partial<Record<StopType, number>> // only stays the user named
  assumed: string[]
  must_haves: string[] // qualities asked for: 'quiet', 'easy parking', ...
  shop_for?: string // what to buy at the shopping stop, in the user's words; '' or absent = nothing said
  named_places?: NamedPlace[] // at most one per stop type; one whose stop type is not in stops is ignored
  unsupported?: string[] // activities asked for that match no stop type ('movie'): said, not planned
}

// What the user asked a stop to have beyond the must-haves: for shopping, the thing to buy. Counts like a must-have.
export const stopWants = (t: StopType, c: Pick<Constraints, 'shop_for'>): string[] =>
  t === 'shopping' && c.shop_for?.trim() ? [`sells ${c.shop_for.trim().toLowerCase()}`] : []

// Open interval in minutes since Sunday 00:00. An interval past midnight Saturday runs over 10080.
export type Interval = [number, number]
// A claim about a place with its source. Shown only with the url (a claim with no source is never shown).
export type Evidence = { attribute: string; claim: string; url: string }

// A candidate place. place_id is always set here (a planner place is always a real Google place).
export type PlannerPlace = Place & {
  place_id: string
  address?: string
  types?: string[]
  open: Interval[] | null // null = hours unknown
  outdoor_seating?: boolean
  parking?: boolean
  attributes: Record<string, boolean> // only attributes we asked about and found a source for
  evidence: Evidence[]
}

// Times are minutes since midnight IST on the day of the outing.
export type Stop = {
  stop_type: StopType
  place: PlannerPlace
  arrive: number
  depart: number
  travel_from_prev_min: number
  warnings: string[]
  reason: string // one line, written by the explainer; '' until then
  closes: number | null // when the place closes after this visit starts; null = unknown
  own?: boolean // the place the user named, not one we searched for
}
export type Itinerary = { stops: Stop[]; total_minutes: number; score: number; warnings: string[]; start_min: number }

// candidates[i] = places for stop i, best first. legs[i][a][b] = minutes from candidates[i][a] to candidates[i+1][b],
// undefined when no route was found.
export type Legs = (number | undefined)[][][]
export type SearchInput = {
  stop_types: StopType[]
  candidates: PlannerPlace[][]
  legs: Legs
  weekday: number // 0 = Sunday
  start_min: number
  duration: number
  max_travel: number
  must_haves?: string[]
  top?: number // default 3
  sunset_min?: number | null
  stay?: Partial<Record<StopType, number>>
  budget?: Budget // over-budget places rank lower (Google price level); none = no penalty
  stop_wants?: string[][] // per stop, what the user asked of it beyond must_haves (stopWants); counts like a must-have
  // Arrive at stop `stop` at minute `at`: the start is worked out backwards from it and start_min is not used.
  // own = its one candidate is the user's named place, kept with a warning when closed instead of rejected.
  fixed?: { stop: number; at: number; own: boolean }
}

// Why combinations were rejected, counted. closed_by = which stop type was closed.
export type Rejected = {
  too_far: number
  closed: number
  over_time: number
  duplicate: number
  sunset_timing: number
  closed_by: Partial<Record<StopType, number>>
}
export type Relaxation = { label: string; change: { max_travel_minutes?: number; start_time?: string; duration_extra?: number } }

export type PlanResult = {
  itineraries: Itinerary[]
  message: string // why nothing fits; '' when there is a plan
  options: Relaxation[]
  rejected?: Rejected
  area_name: string // the place the search was centred on, shown to the user
}

export const maps_url = (p: { place_id: string }) => `https://www.google.com/maps/place/?q=place_id:${p.place_id}`
// Links behind everything said about a place: its Google page (rating, hours) plus any web evidence, no duplicates.
export const sources = (p: PlannerPlace): string[] => [...new Set([maps_url(p), ...p.evidence.map(e => e.url)])]
export type { LatLng }
