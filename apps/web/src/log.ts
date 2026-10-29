// Debug log (Stream D): an append-only event log on the device, one per trip, exported as a JSON file the lead reads.
// Never sent anywhere. Its own IndexedDB, so it never touches the trip store. Logging must never break the app: all errors are swallowed.
import { api, type CallLog } from '@trippy/core'

const KEEP_TRIPS = 5 // oldest trips beyond this are deleted when a new one starts
const ID_KEY = 'trippy-log-trip'

type Ev = { trip: string; t: number; type: string; data: unknown }

const db = new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open('trippy-log', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('events', { autoIncrement: true }).createIndex('trip', 'trip')
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})
const store = (mode: IDBTransactionMode) => db.then(d => d.transaction('events', mode).objectStore('events'))
const done = (r: IDBRequest) => new Promise<any>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })

// Trip id = its start time. Kept in localStorage so a reload continues the same log.
const newId = () => { const id = new Date().toISOString(); localStorage.setItem(ID_KEY, id); return id }
const tripId = () => localStorage.getItem(ID_KEY) ?? newId()

export function log(type: string, data: unknown = {}) {
  const lobby = type === 'call' && (data as CallLog).path === '/maps/autocomplete'
  const ev: Ev = { trip: lobby ? '' : tripId(), t: Date.now(), type, data }
  store('readwrite').then(s => done(s.add(ev))).catch(() => {})
  // Dev only: the local proxy appends it to logs/ on disk, the copy that survives clearing the browser (see apps/proxy/src/server.ts).
  if (import.meta.env.DEV) fetch(api.base + '/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trip: ev.trip, events: [{ ...ev, t: new Date(ev.t).toISOString() }] }) }).catch(() => {})
}

// A new trip starts a new log. Pre-trip lobby events older than an hour go, and so do trips beyond KEEP_TRIPS.
export async function startTrip(info: unknown) {
  try {
    const id = newId()
    const s = await store('readwrite')
    const trips: string[] = []
    for (let c = await done(s.index('trip').openKeyCursor(null, 'nextunique')); c; c.continue(), c = await done(c.request)) {
      if (c.key) trips.push(c.key)
    }
    const drop = new Set(trips.slice(0, Math.max(0, trips.length - KEEP_TRIPS)))
    for (let c = await done(s.openCursor()); c; c.continue(), c = await done(c.request)) {
      const e: Ev = c.value
      if (drop.has(e.trip) || (e.trip === '' && e.t < Date.now() - 3_600_000)) c.delete()
    }
    log('trip_start', { id, ...(info as object) })
  } catch { /* logging is best effort */ }
}

// Everything the proxy calls returned, cut to what a person (or the lead) needs to read; request bodies stay whole.
function summary(path: string, d: any): unknown {
  if (!d || typeof d !== 'object') return d
  if (path === '/llm') return { message: d.choices?.[0]?.message, finish: d.choices?.[0]?.finish_reason, usage: d.usage }
  if (path === '/maps/places') return { places: d.places?.map((p: any) => p.displayName?.text), routingSummaries: d.routingSummaries }
  if (path === '/maps/routes') return d.routes?.map((r: any) => ({ duration: r.duration, meters: r.distanceMeters,
    steps: r.legs?.[0]?.steps?.length, polylineChars: r.polyline?.encodedPolyline?.length }))
  if (path === '/maps/autocomplete') return d.suggestions?.map((s: any) => s.placePrediction?.structuredFormat?.mainText?.text)
  if (path === '/search') return d.results?.map((r: any) => ({ title: r.title, url: r.url }))
  return d // /maps/details is field-masked and small
}

api.onCall = e => log('call', { ...e, data: undefined, response: summary(e.path, e.data) })
addEventListener('error', e => log('error', { message: e.message, at: `${e.filename}:${e.lineno}` }))
addEventListener('unhandledrejection', e => log('error', { message: String(e.reason) }))
// Why a GPS track has a gap: the app was in the background (a PWA gets no GPS there, B1) or the signal was gone.
document.addEventListener('visibilitychange', () => log('visibility', { state: document.visibilityState }))
addEventListener('online', () => log('network', { online: true }))
addEventListener('offline', () => log('network', { online: false }))

async function events(): Promise<Ev[]> {
  const s = await store('readonly')
  return done(s.getAll())
}

function download(name: string, json: unknown) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(json, null, 1)], { type: 'application/json' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000) // revoking at once can cancel the download on Android
}

const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

// Every kept trip (up to KEEP_TRIPS) in time order, each event with its trip id: a second trip the same day (an outing
// started in the evening) must not hide the drive. '' = typed before a trip started (autocomplete).
const kept = async () => (await events()).sort((a, b) => a.t - b.t)

// Downloads trippy-debug-<first event>-<export time>.json. False when there is nothing to export.
export async function exportLog() {
  try {
    const evs = await kept()
    if (!evs.length) return false
    download(`trippy-debug-${stamp(evs[0].t)}-${stamp(Date.now())}.json`,
      { app: 'trippy', exported: new Date().toISOString(), current_trip: localStorage.getItem(ID_KEY),
        trips: [...new Set(evs.map(e => e.trip).filter(Boolean))],
        events: evs.map(e => ({ t: new Date(e.t).toISOString(), trip: e.trip, type: e.type, data: e.data })) })
    return true
  } catch { return false }
}

// Downloads the live GPS fixes of every kept trip as a replay trace {t, lat, lng, at, acc}[], t = seconds since the first
// fix, at = the time. Replay fixes are left out. False when no trip has live GPS fixes.
export async function exportTrace() {
  try {
    const fixes = (await kept()).filter(e => e.type === 'position' && (e.data as any).src === 'gps')
    if (!fixes.length) return false
    download(`trippy-trace-${stamp(fixes[0].t)}.json`, fixes.map(e => ({ t: Math.round((e.t - fixes[0].t) / 1000),
      lat: (e.data as any).lat, lng: (e.data as any).lng, at: new Date(e.t).toISOString(), acc: (e.data as any).acc })))
    return true
  } catch { return false }
}
