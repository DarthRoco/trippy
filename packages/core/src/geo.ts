import type { LatLng } from './types.ts'

// Google encoded polyline format.
export function decode(s: string): LatLng[] {
  const pts: LatLng[] = []
  let i = 0, lat = 0, lng = 0
  while (i < s.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b = 0
      do {
        b = s.charCodeAt(i++) - 63
        result |= (b & 0x1f) << shift
        shift += 5
      } while (b >= 0x20)
      const d = result & 1 ? ~(result >> 1) : result >> 1
      if (k === 0) lat += d
      else lng += d
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return pts
}

export function encode(pts: LatLng[]): string {
  let out = '', plat = 0, plng = 0
  const put = (v: number) => {
    v = v < 0 ? ~(v << 1) : v << 1
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63)
      v >>= 5
    }
    out += String.fromCharCode(v + 63)
  }
  for (const p of pts) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5)
    put(lat - plat)
    put(lng - plng)
    plat = lat
    plng = lng
  }
  return out
}

export function km(a: LatLng, b: LatLng): number {
  const r = Math.PI / 180
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r)
  return Math.hypot(x, (b.lat - a.lat) * r) * 6371
}

// The first `fraction` of a polyline, by distance.
export function cut(polyline: string, fraction: number): string {
  if (fraction >= 1) return polyline
  const pts = decode(polyline)
  const legs = pts.slice(1).map((p, i) => km(pts[i], p))
  let left = legs.reduce((a, b) => a + b, 0) * Math.max(fraction, 0)
  const out = [pts[0]]
  for (let i = 0; i < legs.length; i++) {
    if (legs[i] > 0 && legs[i] >= left) {
      const t = left / legs[i], a = pts[i], b = pts[i + 1]
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t })
      break
    }
    left -= legs[i]
    out.push(pts[i + 1])
  }
  return encode(out)
}

// Nearest point on a polyline to p: how far off it is, how far along, and the polyline from there on.
// ponytail: nearest over the whole line; a route that doubles back on itself could snap ahead. Fine for city drives.
export function along(polyline: string, p: LatLng): { offKm: number; doneKm: number; totalKm: number; rest: string } {
  const pts = decode(polyline)
  let best = { offKm: km(p, pts[0]), doneKm: 0, i: 0, at: pts[0] }
  let walked = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = km(a, b)
    // Project p onto a-b in a local flat frame (km per degree differs for lng).
    const kx = Math.cos((a.lat * Math.PI) / 180)
    const dx = (b.lng - a.lng) * kx, dy = b.lat - a.lat
    const t = d > 0 ? Math.min(1, Math.max(0, ((p.lng - a.lng) * kx * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy))) : 0
    const at = { lat: a.lat + dy * t, lng: a.lng + (b.lng - a.lng) * t }
    const off = km(p, at)
    if (off < best.offKm) best = { offKm: off, doneKm: walked + d * t, i, at }
    walked += d
  }
  const rest = [best.at, ...pts.slice(best.i || 1)]
  if (rest.length < 2) rest.push(best.at)
  return { offKm: best.offKm, doneKm: best.doneKm, totalKm: walked, rest: encode(rest) }
}

export const OFF_ROUTE_KM = 0.3 // Q18

