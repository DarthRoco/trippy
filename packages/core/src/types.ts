// Trip model v2 (DESIGN.md "Trip model v2"). Store facts, compute the rest: everything here is what a source told us
// (GPS, Google, the user, remember / forget), replaced whole when the source answers again. ahead, next_steps,
// off_route, arrived and shown are computed on read (context.ts) and never stored.
export type LatLng = { lat: number; lng: number }
export type Fix = LatLng & { t: string } // ISO, IST

// A real Google place in this trip. place_id null = "Current location". Facts are left out when Google gave none.
export type Place = {
  place_id: string | null
  name: string
  location: LatLng
  rating?: number
  reviews?: number
  price?: string // INEXPENSIVE, MODERATE, ...
  open_now?: boolean
  type?: string // Google primaryType, e.g. vegetarian_restaurant
  serves_veg?: boolean // has veg dishes; not the same as a pure-veg place
}

export type PlanEntry = { ref: string; kind: 'stop' | 'destination'; reached_at: string | null }

// One leg exactly as Google returned it: to the plan entry `to`. Never trimmed or patched.
export type RouteLeg = { to: string; polyline: string; duration_sec: number; distance_m: number; steps: Step[] }
export type Step = { text: string; km: number }

// A search result's minutes belong to the search (from where it ran), not to the place.
export type Candidate = { ref: string; min: number; detour_min?: number; from_dest?: true; asked_for?: true }
export type FindStopsArgs = {
  need: string
  similar_to?: string
  limit_type: 'from_now' | 'detour' | 'near_destination'
  limit_min: number
  places?: string[]
  notes?: string
}
export type Search = {
  id: string // s1, s2, ...
  at: string
  from: LatLng
  asked: string // the user's words
  args: FindStopsArgs
  candidates: Candidate[]
  picks: { ref: string; reason: string }[]
  say: string
}

export type Note = { id: string; text: string }
// Points at a search or a link ref; never copies places. sos: the 112 button (Q35), survives reload.
// how: "How Trippy decided" (FEATURES #25), shown behind a Settings toggle. history() sends only text, never this.
export type Message = { role: 'user' | 'assistant'; text: string; search?: string; link?: string; sos?: true; how?: How }
// One turn: time taken, each model call in order (a MODELS key, or the own-key model id), map calls, the tool calls that ran.
export type How = { ms: number; models: string[]; maps: number; steps: { name: string; args: any }[] }

export type Trip = {
  id: string // start time
  origin: string // ref
  plan: PlanEntry[] // empty = no destination (G2)
  fix: Fix
  still?: Fix // the first fix of the current stay within ~150 m (stop logging, #3)
  live: boolean // live GPS drives the trip only when the phone is there
  route: RouteLeg[] | null // from the fix at the last refresh through every unreached plan entry
  places: Record<string, Place> // p1, p2, ... never reused
  searches: Search[]
  notes: Note[]
  messages: Message[]
}

// A place found by a search, before find_stops filters it. legsSec = [here -> place, place -> route end].
export type Hit = Place & { place_id: string; legsSec: number[] }

// A picked suggestion routes by place id (exact); a plain string is geocoded by Google (test runners only).
export type Suggestion = { placeId: string; main: string; secondary: string }
export type Where = string | { placeId: string } | LatLng

// Swappable map data source (Q6). GoogleProvider now; OpenProvider (OSRM + Overture) is a SHOULD.
export interface MapProvider {
  // One leg per `to`, in order (Routes intermediates). Legs carry no `to` ref; the caller adds it.
  route(from: Where, to: Where[]): Promise<Omit<RouteLeg, 'to'>[]>
  autocomplete(input: string, near?: LatLng): Promise<Suggestion[]>
  searchAlongRoute(query: string, polyline: string, origin: LatLng, max: number): Promise<Hit[]>
  // With origin: legsSec = [origin -> place] (traffic-aware). Without: legsSec empty, cheaper SKU.
  searchNear(query: string, center: LatLng, radiusM: number, max: number, origin?: LatLng): Promise<Hit[]>
  details(placeId: string): Promise<Record<string, unknown>> // hours, phone, address, price, parking, reservable
  nearest(center: LatLng, radiusM: number): Promise<{ place_id: string; name: string } | null> // names a logged stop
  eta(from: LatLng, to: LatLng, departAt?: string): Promise<{ durationSec: number; distanceM: number }>
}
