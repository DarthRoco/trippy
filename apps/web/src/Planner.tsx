import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Map, AdvancedMarker, useMap } from '@vis.gl/react-google-maps'
import { ParseError, RUPEES, STOP_TYPES, UnknownArea, Unsupported, cannotPlan, clock, decode, googleProvider, maps_url, parseRequest, placeSources, planOuting,
  type LatLng, type Place,
  type Budget, type Constraints, type Itinerary, type PlanResult, type Relaxation, type Stop, type StopType } from '@trippy/core'
import { Icon } from './Icon.tsx'
import { PlaceInput, type Place as Typed } from './PlaceInput.tsx'

const EXAMPLES = [
  'I have 3 hours on Sunday afternoon in Indiranagar. Coffee, then a quiet place to work for an hour, then a sunset spot. No more than 30 minutes between stops.',
  'Find a calm, easy-parking dinner in Koramangala, then a walkable spot afterwards for my parents.',
  'Saturday morning in Bandra, 2 hours: a coffee and then a short walk in a park.',
]
const ASSUMED: Record<string, string> = { start_time: 'start time', duration_minutes: 'how long you have', day: 'day',
  max_travel_minutes: 'travel limit', budget: 'budget' }
// ?noweb in the address skips web evidence (test runs: the web search allowance is small).
const WEB = !new URLSearchParams(location.search).has('noweb')
const CAN_PLAN = `I can plan outings made of these stops: ${STOP_TYPES.join(', ')}. Try something like "Sunday afternoon in Indiranagar: coffee, then a walk".`
// A map's colour scheme is fixed when it is created, so the map is recreated when the device theme changes.
const scheme = matchMedia('(prefers-color-scheme: dark)')
const useDark = () => useSyncExternalStore(f => { scheme.addEventListener('change', f); return () => scheme.removeEventListener('change', f) }, () => scheme.matches)
const host = (url: string) => (url.includes('google.com/maps') ? 'Google Maps' : new URL(url).hostname.replace(/^www\./, ''))
// How sure we are: two or more separate sites plus known hours = high. Counts sites, not snippets.
function confidence(s: Stop) {
  const sites = new Set(s.place.evidence.map(e => new URL(e.url).hostname)).size
  return sites >= 2 && s.place.open ? 'high' : sites || s.place.open ? 'medium' : 'low'
}

// Plan an outing before leaving: ask -> check what was understood -> timeline + map -> "Start this outing" hands the
// chosen option's stops to the trip screen (onGo). Nothing is stored before that (a reload starts over).
export function Planner({ onBack, onGo }: { onBack: () => void; onGo: (stops: Place[]) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [c, setC] = useState<Constraints | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [res, setRes] = useState<PlanResult | null>(null)
  const [pick, setPick] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const dark = useDark()
  const it = res?.itineraries[pick]
  // The road through the stops, as on the trip screen: one Google route call (via the relay) per option shown, kept
  // for the session. Straight lines until it arrives, or if it fails.
  const [roads, setRoads] = useState<Record<string, LatLng[]>>({})
  const roadKey = it?.stops.map(s => s.place.place_id).join() ?? ''
  useEffect(() => {
    if (!it || it.stops.length < 2 || roads[roadKey]) return
    const [first, ...rest] = it.stops
    googleProvider.route({ placeId: first.place.place_id }, rest.map(s => ({ placeId: s.place.place_id })))
      .then(legs => setRoads(r => ({ ...r, [roadKey]: legs.flatMap(l => decode(l.polyline)) })))
      .catch(() => {})
  }, [roadKey])

  async function read(request = text) {
    if (!request.trim()) return setError('Type what you want to do, or pick one of the examples.')
    setError(''); setRes(null); setC(null); setBusy('Reading your request')
    try { setC(await parseRequest(request)) }
    catch (e) {
      setError(e instanceof Unsupported ? CAN_PLAN
        : e instanceof ParseError ? "I couldn't read that request. Say where, when and which stops you want, or pick an example." : String(e))
    }
    setBusy('')
  }
  async function go(cc: Constraints) {
    setError(''); setRes(null); setPick(0); setSelected(null); setC(cc); setBusy('Starting')
    try { setRes(await planOuting(cc, { onStep: setBusy, web: WEB })) }
    catch (e) { setError(e instanceof UnknownArea ? e.message : `Planning failed: ${e instanceof Error ? e.message : e}`) }
    setBusy('')
  }
  // The trip keeps only the place facts it uses; "name, address" so its chat model knows where each stop is (as Start).
  async function start(stops: Stop[]) {
    setBusy('Starting the trip'); setError('')
    const ok = await onGo(stops.map(({ place: p }) => ({ place_id: p.place_id, name: p.address ? `${p.name}, ${p.address}` : p.name,
      location: p.location, rating: p.rating, reviews: p.reviews, price: p.price })))
    if (!ok) { setBusy(''); setError("Couldn't start the trip. Check your connection and try again.") }
  }
  const relax = (o: Relaxation) => c && go({ ...c,
    max_travel_minutes: o.change.max_travel_minutes ?? c.max_travel_minutes,
    start_time: o.change.start_time ?? c.start_time,
    duration_minutes: c.duration_minutes + (o.change.duration_extra ?? 0) })

  if (it) return (
    <div className="trip">
      <div className="map">
        <OutingMap key={dark ? 'dark' : 'light'} stops={it.stops} road={roads[roadKey] ?? null} selected={selected} onSelect={setSelected}
          fitKey={`${res!.area_name}${pick}${roads[roadKey] ? 'road' : ''}`} />
      </div>
      <div className="panel">
        <header className="tripbar">
          <button className="icon-btn" aria-label="Change the request" onClick={() => setRes(null)}><Icon name="back" /></button>
          <div className="route"><span className="text">
            <b>Outing around {res!.area_name}</b>
            <span>{clock(it.start_min)} to {clock(it.start_min + it.total_minutes)} · {it.stops.length} stops</span>
          </span></div>
        </header>
        <div className="outing">
          {res!.itineraries.length > 1 && (
            <div className="chips" role="tablist" aria-label="Options">
              {res!.itineraries.map((_, i) => (
                <button key={i} role="tab" aria-selected={i === pick} className={'chip' + (i === pick ? ' on' : '')}
                  onClick={() => { setPick(i); setSelected(null) }}>Option {i + 1}</button>
              ))}
            </div>
          )}
          {it.warnings.map(w => <div key={w} className="banner" role="status"><p>{w}</p></div>)}
          <Timeline it={it} selected={selected} onSelect={setSelected} />
          {error && <p className="note" role="alert">{error}</p>}
          <button className="btn primary wide" disabled={!!busy} onClick={() => start(it.stops)}>
            {busy ? `${busy}…` : 'Start this outing'}</button>
        </div>
      </div>
    </div>
  )

  return (
    <main className="screen">
      <div className="screen-head">
        <button className="icon-btn" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        <h1 className="h">Plan an outing</h1>
      </div>
      <form className="section ask" onSubmit={e => { e.preventDefault(); read() }}>
        <textarea value={text} onChange={e => setText(e.target.value)} aria-label="Describe your outing"
          placeholder="Say where, when, how long, and what you want to do." />
        <div className="chips">
          {EXAMPLES.map(x => <button type="button" key={x} className="chip" disabled={!!busy} onClick={() => { setText(x); read(x) }}>{x.slice(0, 44)}…</button>)}
        </div>
        <button className="btn primary wide" disabled={!!busy}>{c ? 'Read it again' : 'Read my request'}</button>
      </form>
      {c && !busy && <Understood c={c} onPlan={go} />}
      {busy && <div className="msg assistant steps" role="status"><p>{busy}…</p></div>}
      {error && <p className="note" role="alert">{error}</p>}
      {res && !res.itineraries.length && (
        <section className="section">
          <h2>Nothing fits</h2>
          <p>{res.message}</p>
          {res.options.map(o => <button key={o.label} className="btn wide" disabled={!!busy} onClick={() => relax(o)}>{o.label}</button>)}
        </section>
      )}
    </main>
  )
}

// What the parser understood, editable before anything is searched. Stays the user named are kept as parsed.
function Understood({ c, onPlan }: { c: Constraints; onPlan: (c: Constraints) => void }) {
  const [d, setD] = useState(c)
  const [musts, setMusts] = useState(c.must_haves.join(', '))
  const [area, setArea] = useState<Typed>({ text: c.area }) // the box shows the pick's name; d.area gets "name, city" for the search
  useEffect(() => { setD(c); setMusts(c.must_haves.join(', ')); setArea({ text: c.area }) }, [c])
  const set = <K extends keyof Constraints>(k: K, v: Constraints[K]) => setD({ ...d, [k]: v })
  // Tap order is visit order: a new stop goes last.
  const toggle = (t: StopType) => set('stops', d.stops.includes(t) ? d.stops.filter(s => s !== t) : [...d.stops, t])
  const ok = d.stops.length > 0 && /^\d{2}:\d{2}$/.test(d.start_time) && d.duration_minutes > 0 && !!d.area.trim()
  // The user's own places for the stops still chosen; a set time there makes the start worked out, not assumed.
  const named = (d.named_places ?? []).filter(p => d.stops.includes(p.stop))
  const timed = named.some(p => p.time)
  const assumed = c.assumed.filter(f => !(f === 'start_time' && timed))
  return (
    <form className="section" onSubmit={e => { e.preventDefault(); if (ok) onPlan({ ...d, must_haves: musts.split(',').map(m => m.trim()).filter(Boolean) }) }}>
      <h2>What I understood</h2>
      {!!c.unsupported?.length && <p>{cannotPlan(c.unsupported, 'will plan')}</p>}
      {named.length > 0 && <p>Your own {named.length > 1 ? 'places' : 'place'}: {named.map(p => `${p.name} (${p.stop}${p.time ? ` at ${p.time}` : ''})`).join(', ')}.
        {timed && ' I will time the other stops around it.'}</p>}
      {assumed.length > 0 && (
        <p>You did not say your {assumed.map(f => `${ASSUMED[f] ?? f} (${c[f as keyof Constraints]})`).join(', ')}, so I assumed these. Change them here if you want something else.</p>
      )}
      <div className="fields">
        <label>Area<PlaceInput label="Area" place={area}
          onChange={p => { setArea(p); set('area', p.pick ? `${p.pick.main}, ${p.pick.secondary}` : p.text) }} /></label>
        <label>Day<input value={d.day} onChange={e => set('day', e.target.value)} /></label>
        {!timed && <label>Start<input type="time" value={d.start_time} onChange={e => set('start_time', e.target.value)} /></label>}
        <label>How long (minutes)<input type="number" min={1} value={d.duration_minutes} onChange={e => set('duration_minutes', Number(e.target.value))} /></label>
        <label>Longest travel between stops (minutes)<input type="number" min={0} value={d.max_travel_minutes} onChange={e => set('max_travel_minutes', Number(e.target.value))} /></label>
        <label>Budget<select value={d.budget} onChange={e => set('budget', e.target.value as Budget)}>
          {['low', 'medium', 'high'].map(b => <option key={b}>{b}</option>)}</select></label>
        <label>Must-haves, comma separated<input value={musts} onChange={e => setMusts(e.target.value)} placeholder="quiet, easy parking" /></label>
        {d.stops.includes('shopping') && <label>Shopping for<input value={d.shop_for ?? ''} onChange={e => set('shop_for', e.target.value)} placeholder="a gift, books, a statement ring" /></label>}
      </div>
      <div className="chips" aria-label="Stops, in visit order">
        {STOP_TYPES.map(t => (
          <button type="button" key={t} className={'chip' + (d.stops.includes(t) ? ' on' : '')} aria-pressed={d.stops.includes(t)} onClick={() => toggle(t)}>
            {d.stops.includes(t) && <b>{d.stops.indexOf(t) + 1}</b>}{t}
          </button>
        ))}
      </div>
      <button className="btn primary wide" disabled={!ok}>Plan my outing</button>
    </form>
  )
}

// Stops in order, numbered to match the pins. Every card lists its sources; "Why?" shows each claim with its link.
function Timeline({ it, selected, onSelect }: { it: Itinerary; selected: number | null; onSelect: (i: number) => void }) {
  return (
    <div className="cards">
      {it.stops.map((s, i) => (
        <div key={s.place.place_id + i}>
          {s.travel_from_prev_min > 0 && <p className="leg">{s.travel_from_prev_min} min travel</p>}
          <div className={'card' + (i === selected ? ' selected' : '')} id={`stop-${i}`}>
            <span className="n">{i + 1}</span>
            <span className="body">
              <button className="name" onClick={() => onSelect(i)}>{s.place.name}</button>
              <span className="meta">{s.own && <span className="tag on">Your place</span>} {s.stop_type} · {clock(s.arrive)} to {clock(s.depart)}
                {s.place.rating != null && ` · ${s.place.rating}★ (${s.place.reviews ?? 0})`}
                {s.place.price && RUPEES[s.place.price] && ` · ${RUPEES[s.place.price]}`} · confidence {confidence(s)}</span>
              {s.reason && <span className="why">{s.reason}</span>}
              <span className="src">Sources: {placeSources(s.place).map((u, k) => (
                <span key={u}>{k > 0 && ', '}<a href={u} target="_blank" rel="noreferrer">{host(u)}</a></span>))}</span>
              <details>
                <summary>Why?</summary>
                <ul>
                  {s.place.rating != null && <li>Rated {s.place.rating} from {s.place.reviews ?? 0} Google reviews (<a href={maps_url(s.place)} target="_blank" rel="noreferrer">source</a>)</li>}
                  {s.place.evidence.map(e => <li key={e.attribute + e.url}>{e.claim} (<a href={e.url} target="_blank" rel="noreferrer">source</a>)</li>)}
                  {!s.place.evidence.length && <li>No web evidence found for what you asked about.</li>}
                  <li>{s.place.open ? 'Hours checked against Google' : 'Hours unknown'}{s.place.address && `. ${s.place.address}`}</li>
                </ul>
              </details>
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

type MapProps = { stops: Stop[]; road: LatLng[] | null; selected: number | null; onSelect: (i: number) => void; fitKey: string }
// A map failure (bad key, blocked referrer, no network) leaves the timeline working, as on the trip screen.
class OutingMap extends Component<MapProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render(): ReactNode {
    if (this.state.failed) return <p className="map-off">Map unavailable. The plan below still works.</p>
    const { stops, road, selected, onSelect, fitKey } = this.props
    return (
      <Map defaultCenter={stops[0].place.location} defaultZoom={14} mapId="DEMO_MAP_ID" colorScheme="FOLLOW_SYSTEM" disableDefaultUI gestureHandling="greedy">
        <Path stops={stops} road={road} selected={selected} fitKey={fitKey} />
        {stops.map((s, i) => (
          <AdvancedMarker key={s.place.place_id + i} position={s.place.location} title={s.place.name} zIndex={i === selected ? 10 : 1}
            onClick={() => { onSelect(i); document.getElementById(`stop-${i}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }}>
            <div className={'pin' + (i === selected ? ' on' : '')}><b>{i + 1}</b></div>
          </AdvancedMarker>
        ))}
      </Map>
    )
  }
}

// The road through the stops in visit order, drawn like the trip screen's route; straight lines between the stops until
// the road arrives. Fitted to the map.
function Path({ stops, road, selected, fitKey }: Omit<MapProps, 'onSelect'>) {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    const color = getComputedStyle(document.documentElement).getPropertyValue('--route').trim()
    const path = road ?? stops.map(s => s.place.location)
    const line = new google.maps.Polyline({ path, map, strokeColor: color, strokeOpacity: 0.9, strokeWeight: road ? 5 : 3 })
    const fit = () => {
      if (path.length > 1) {
        const bounds = new google.maps.LatLngBounds()
        path.forEach(p => bounds.extend(p))
        map.fitBounds(bounds, 60)
      } else { map.setCenter(path[0]); map.setZoom(15) }
    }
    fit()
    // Refit when the width changes (rotation, window resize). Width only: a phone keyboard changes the height.
    let width = innerWidth
    const onResize = () => { if (innerWidth !== width) { width = innerWidth; fit() } }
    addEventListener('resize', onResize)
    return () => { line.setMap(null); removeEventListener('resize', onResize) }
  }, [map, fitKey])
  useEffect(() => { if (map && selected != null) map.panTo(stops[selected].place.location) }, [map, selected])
  return null
}
