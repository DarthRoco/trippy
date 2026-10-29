import { along, cut, decode, km } from './geo.ts'
import type { MapProvider, Candidate, FindStopsArgs, Hit, LatLng, Place } from './types.ts'

export type { FindStopsArgs }
// Where a search runs from: the latest fix and the road still ahead of it (context.ts routeAhead; null = no
// destination (G2) or every plan entry reached).
export type From = { fix: LatLng; ahead: { polyline: string; sec: number } | null }
// A place that fits, with this search's minutes. The tool runner gives it a trip ref.
export type Found = Place & Omit<Candidate, 'ref'>
type Found_ = Found & { place_id: string }

// Search method, chosen by code (never by the model): B+ (DECISIONS 2026-10-03, final 2026-10-08). Search along the stretch
// reachable in limit_min (from_now; the whole route for detour), closed and thin places (few reviews, or a name with no
// Latin letters) filtered, scored, and one radius search if results are thin.
const REACH_SHARE = 0.75 // search the first 75% of the reachable stretch; the rest of limit_min is getting off the road
const SLACK_SEC = 120 // drive times swing a minute or two between calls; don't lose a good place to noise
const ENOUGH = 4 // fewer good candidates than this -> one radius search around the current position
const MIN_REVIEWS = 20 // places with fewer reviews only fill in when there aren't enough others
// The family is in a car: a repair search drops two-wheeler shops (ride 2026-10-18: "Rehal Two Wheeler Garage" for a failing clutch).
const CAR_FIX = /\b(repair|garage|mechanic|tyre|tire|puncture|service|clutch|brake|battery|tow|towing)/i
const TWO_WHEEL = /\b(two|2)[ -]?wheelers?\b|\b(bike|bikes|scooter|scooty|motorcycle|moped|activa)\b/i

export async function findStops(p: MapProvider, { fix, ahead }: From, a: FindStopsArgs): Promise<Found[]> {
  const limitSec = a.limit_min * 60
  const fromNow = a.limit_type === 'from_now'
  // similar_to: same brand first, then the generic need (DESIGN.md).
  const queries = a.similar_to ? [a.similar_to, a.need] : [a.need]
  const veg = /\b(veg|jain)/i.test(`${a.need} ${a.notes ?? ''}`)
  // places: names the model proposes (famous sites for a topic, a place the user named). Each is looked up and only
  // the top real match is kept, so the model still never invents a place. Named matches lead the shortlist.
  const named = (a.places ?? []).slice(0, 4)
  const run = async (search: (q: string, max: number) => Promise<Hit[]>) => {
    const [n, rest] = await Promise.all([
      Promise.all(named.map(q => search(q, 1))), Promise.all(queries.map(q => search(q, 20)))])
    return { hits: [...n.flat(), ...rest.flat()], ids: new Set(n.flat().map(h => h.place_id)) }
  }

  if (!ahead) {
    // No destination (G2) or everything reached: a circle around the fix, sized by how far you get in limit_min
    // (~15 km/h), drive times from the fix. A detour or near_destination limit then means minutes from here.
    const radius = Math.min(50000, a.limit_min * 250)
    const { hits, ids } = await run((q, max) => p.searchNear(q, fix, radius, max, fix))
    return shortlist(toFound({ ...a, limit_type: 'from_now' }, 0, hits, SLACK_SEC, ids), ids, veg)
  }

  if (a.limit_type === 'near_destination') {
    // Around the destination (the end of the road ahead), drive times measured from it. Closed-now places stay: you arrive later.
    const dest = decode(ahead.polyline).at(-1)!
    const radius = Math.min(50000, a.limit_min * 400) // ~24 km/h city driving
    const { hits, ids } = await run((q, max) => p.searchNear(q, dest, radius, max, dest))
    return shortlist(toFound(a, ahead.sec, hits, SLACK_SEC, ids), ids, veg, false).map(c => ({ ...c, from_dest: true as const }))
  }

  // ponytail: assumes even speed along the route to find the reachable stretch; use step durations if recall suffers
  const stretch = fromNow ? cut(ahead.polyline, (limitSec * REACH_SHARE) / ahead.sec) : ahead.polyline
  const along = await run((q, max) => p.searchAlongRoute(q, stretch, fix, max))

  let hits = along.hits
  if (fromNow && ahead.sec < limitSec) {
    // The destination is within reach: places just past where the route ends count too (Haji Ali, #41). A circle
    // around it sized by the minutes left over (~24 km/h), drive times from the fix.
    const dest = decode(ahead.polyline).at(-1)!
    const radius = Math.max(1000, ((limitSec - ahead.sec) / 60) * 400)
    hits = [...hits, ...(await Promise.all(queries.map(q => p.searchNear(q, dest, radius, 20, fix)))).flat()]
  }
  if (fromNow && keep(toFound(a, ahead.sec, hits, SLACK_SEC), veg).length < ENOUGH) {
    // Thin results: search a circle around the current position, sized by how far you get in limit_min (~15 km/h).
    const radius = Math.min(50000, a.limit_min * 250)
    hits = [...hits, ...await p.searchNear(a.need, fix, radius, 20, fix)]
  }
  return shortlist(toFound(a, ahead.sec, hits, SLACK_SEC, along.ids), along.ids, veg)
}

// Top 10 for the ranker: named matches first (they were asked for), then the B+ filtered and scored rest.
function shortlist(cs: Found_[], named: Set<string>, veg: boolean, dropClosed = true): Found[] {
  return [...cs.filter(c => named.has(c.place_id)), ...keep(cs.filter(c => !named.has(c.place_id)), veg, dropClosed)]
    .slice(0, 10).map(c => (named.has(c.place_id) ? { ...c, asked_for: true as const } : c))
}

// Dedupe, compute reach and detour (vs routeSec, the drive time still ahead), keep what fits the limit (+ slack).
// Named places (asked for by name) are kept up to an hour away with their real time; the limit is for generic search.
function toFound(a: FindStopsArgs, routeSec: number, hits: Hit[], slackSec: number, named = new Set<string>()): Found_[] {
  const seen = new Set<string>()
  const out: Found_[] = []
  for (const { legsSec, ...place } of hits) {
    if (seen.has(place.place_id)) continue
    seen.add(place.place_id)
    if (CAR_FIX.test(a.need) && TWO_WHEEL.test(place.name) && !named.has(place.place_id)) continue
    const [toIt = Infinity, onward = 0] = legsSec
    // ponytail: clamp at 0; route and per-place times are separate traffic estimates and can disagree by a minute or two
    const detour = a.limit_type === 'detour' ? Math.max(0, Math.round((toIt + onward - routeSec) / 60)) : undefined
    const ok = named.has(place.place_id) ? toIt <= 3600
      : detour == null ? toIt <= a.limit_min * 60 + slackSec : detour * 60 <= a.limit_min * 60 + slackSec
    if (ok) out.push({ ...place, min: Math.round(toIt / 60), ...(detour != null && { detour_min: detour }) })
  }
  return out
}

// B+: drop places closed now, keep thin-review places only as filler, order by a review-weighted rating.
// The ranker (Ultra) still makes the final call on the top 10; this only decides which 10 it sees.
function keep<T extends Found>(cs: T[], veg: boolean, dropClosed = true): T[] {
  // Veg request: drop places Google says serve no veg food. Pure-veg vs veg options is left to the ranker (type field).
  const open = cs.filter(c => !(dropClosed && c.open_now === false) && !(veg && c.serves_veg === false))
  // A name with no Latin letter (Google has no English name for it, TESTSET #46) is filler only, like thin reviews.
  const solid = open.filter(c => (c.reviews ?? 0) >= MIN_REVIEWS && /[A-Za-z]/.test(c.name))
  const pool = solid.length >= ENOUGH ? solid : open
  // Bayesian rating: few reviews pull toward 3.8; minus a little per minute of travel.
  const score = (c: Found) =>
    ((c.rating ?? 3.8) * (c.reviews ?? 0) + 3.8 * 50) / ((c.reviews ?? 0) + 50) - 0.02 * (c.detour_min ?? c.min)
  return pool.sort((x, y) => score(y) - score(x))
}

// Behind the car: the road ahead never comes within reach of it after its first 300 m, and it lies against the direction of travel
// (ride 2026-10-18: Balkum Metro, back in Thane, was shown before Airoli ahead). Code orders picks with it; the ranker only chooses.
// ponytail: straight-line heading over the first ~300 m; a hairpin right at the car can misjudge one place.
export function behind(loc: LatLng, { fix, ahead }: From): boolean {
  if (!ahead) return false
  const pts = decode(ahead.polyline)
  if (along(ahead.polyline, loc).doneKm > 0.3) return false
  const to = pts.find(p => km(fix, p) > 0.3) ?? pts.at(-1)!
  const kx = Math.cos((fix.lat * Math.PI) / 180)
  return (to.lng - fix.lng) * kx * (loc.lng - fix.lng) * kx + (to.lat - fix.lat) * (loc.lat - fix.lat) < 0
}
