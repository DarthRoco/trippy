import { decode, km, type LatLng, type RouteLeg } from '@trippy/core'
import { log } from './log.ts'

// Position sources. Live GPS and replay both call the same onFix (DESIGN "Who writes what"), so the rest of the app
// cannot tell them apart. Each returns a stop function.

const EVERY_MS = 10_000 // GPS watcher pace (~10 s)

// Live GPS while the app is open (B1: PWAs get no background location).
// acc = the reading's accuracy in metres, for the debug log (a 2 km jump with acc 1500 is a bad fix, not a move).
export function watchGps(onFix: (p: LatLng & { acc: number }) => void): () => void {
  let last = 0
  const id = navigator.geolocation.watchPosition(g => {
    if (Date.now() - last < EVERY_MS) return
    last = Date.now()
    onFix({ lat: g.coords.latitude, lng: g.coords.longitude, acc: Math.round(g.coords.accuracy) })
  }, e => log('gps_error', { code: e.code, message: e.message }), { enableHighAccuracy: true })
  return () => navigator.geolocation.clearWatch(id)
}

export const here = () => new Promise<LatLng>((resolve, reject) => navigator.geolocation.getCurrentPosition(
  g => resolve({ lat: g.coords.latitude, lng: g.coords.longitude }), reject, { enableHighAccuracy: true, timeout: 10_000 }))

// A recorded trace: seconds since start + position. The real Kurla -> Juhu one goes in traces/ after the Thu 8 Oct ride.
export type Trace = { t: number; lat: number; lng: number }[]

// Stand-in until a real trace exists: drive the given legs at each leg's average traffic speed, one point every ~200 m.
export function fakeTrace(legs: RouteLeg[]): Trace {
  const out: Trace = []
  let t = 0
  for (const leg of legs) {
    const pts = decode(leg.polyline)
    const total = pts.slice(1).reduce((s, p, i) => s + km(pts[i], p), 0) || 1
    const t0 = t
    let walked = 0, lastKept = 0
    if (!out.length) out.push({ t, ...pts[0] })
    for (let i = 1; i < pts.length; i++) {
      walked += km(pts[i - 1], pts[i])
      if (walked - lastKept >= 0.2 || i === pts.length - 1) {
        t = t0 + (leg.duration_sec * walked) / total
        out.push({ t, ...pts[i] })
        lastKept = walked
      }
    }
  }
  return out
}

// Plays a trace through onFix, `speed` trace seconds per real second, one fix per EVERY_MS of trace time.
export function play(trace: Trace, speed: number, onFix: (p: LatLng) => void, onEnd: () => void): () => void {
  let t = 0
  const tick = () => {
    t += EVERY_MS / 1000
    const i = trace.findIndex(p => p.t >= t)
    const { lat, lng } = trace[i < 0 ? trace.length - 1 : i]
    onFix({ lat, lng })
    if (i < 0) { clearInterval(id); onEnd() }
  }
  const id = setInterval(tick, EVERY_MS / speed)
  return () => clearInterval(id)
}
