import { useEffect, useMemo, useState } from 'react'
import { APIProvider } from '@vis.gl/react-google-maps'
import { cards, decode, encode, routeAhead, withStop, type PlanEntry, type Trip } from '@trippy/core'
import { NO_SIGNAL, noSignal, useTrip } from './useTrip.ts'
import { log } from './log.ts'
import { Chat } from './Chat.tsx'
import { Icon } from './Icon.tsx'
import { Landing, Profile, Settings } from './Screens.tsx'
import { TripMap } from './TripMap.tsx'
import { PlaceInput, type Place } from './PlaceInput.tsx'
import { Planner } from './Planner.tsx'

type View = 'home' | 'trip' | 'settings' | 'profile' | 'planner' // planner = plan an outing before leaving; its own screen and state
type Preview = { ref: string; plusMin?: number; line?: string } // no plusMin yet = route on its way

const short = (name: string) => name.split(',')[0]

// Google Maps directions through the plan still ahead, stops as waypoints, so the driver's app carries the stop.
// No origin: Maps starts from the phone's own position.
function mapsLink(t: Trip, plan: PlanEntry[]) {
  const to = plan.filter(e => !e.reached_at).map(e => t.places[e.ref])
  const last = to.pop()
  if (!last) return undefined
  const at = (p: { location: { lat: number; lng: number } }) => `${p.location.lat},${p.location.lng}`
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${at(last)}` +
    (last.place_id ? `&destination_place_id=${last.place_id}` : '') +
    (to.length ? `&waypoints=${encodeURIComponent(to.map(at).join('|'))}` : '')
}

// Screens and view-only state. Trip, chat and memory state live in useTrip.
export default function App() {
  const t = useTrip()
  const { trip, busy, banner } = t
  const [view, setView] = useState<View>('home')
  const [back, setBack] = useState<View>('home') // where settings / profile return to
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null) // placeId highlighted on map + card
  const [preview, setPreview] = useState<Preview | null>(null) // add-stop preview, never stored
  const [sheet, setSheet] = useState(false) // plan sheet open
  const [ending, setEnding] = useState(false) // End trip tapped, waiting for the in-app confirm
  const [next, setNext] = useState<Place>({ text: '' }) // "Where next?"
  // Pins = the latest answer with places. Text follow-ups ("is it open?") keep them; a new search replaces them.
  const lastSearch = trip?.messages.findLast(m => m.search)?.search
  const picks = trip ? cards(trip, lastSearch) : []
  const sos = !!trip?.messages.some(m => m.sos)
  // The road still ahead, cut at the fix, so the line starts at "you" and shrinks as the car moves.
  const road = useMemo(() => (trip ? routeAhead(trip)?.polyline ?? '' : ''), [trip?.route, trip?.plan, trip?.fix])
  const stops = trip ? trip.plan.filter(e => e.kind === 'stop' && !e.reached_at).map(e => trip.places[e.ref].location) : []
  const dests = trip ? trip.plan.filter(e => e.kind === 'destination') : []
  const dest = trip && trip.places[dests.at(-1)?.ref ?? '']
  const left = t.ahead.at(-1)
  useEffect(() => { if (trip) setView('trip') }, [!!trip]) // a trip restored from IndexedDB opens straight away

  const open = (v: 'settings' | 'profile') => { setBack(view); setView(v) }
  const enter = () => { setSelected(null); setError(''); setPreview(null); setSheet(false); setEnding(false); setView('trip') }
  const select = (id: string) => {
    log('card_tap', { placeId: id })
    setSelected(id)
    document.getElementById(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  async function go(from: Place, to: Place) {
    setError('')
    if (await t.start(from.pick!, to.pick!)) enter()
    else setError("Couldn't find a route between those places. Try others.")
  }
  async function goHere() {
    setError('')
    if (await t.startHere()) enter()
    else setError('Location is off. Allow location access to search around you.')
  }
  function ask(text: string) {
    if (busy || !trip) return
    setSelected(null)
    setError('') // an Add stop "No signal" line is old news once the next question goes out
    setSheet(false) // the answer needs the room
    // "We reached, end here" (C): the plan sheet opens on the End-trip confirm; the user still taps it.
    t.send(text).then(end => { if (end) { setSheet(true); setEnding(true) } })
  }
  async function addStop(ref: string) {
    setError('')
    setPreview({ ref })
    let why = `Couldn't find a route via ${short(trip!.places[ref].name)}.`
    const p = await t.previewStop(ref).catch(e => { if (noSignal(e)) why = NO_SIGNAL; return null })
    // A newer tap (another card, Cancel) wins over this answer.
    setPreview(cur => cur?.ref !== ref || cur.plusMin != null ? cur
      : p ? { ref, plusMin: p.plusMin, line: encode(p.legs.flatMap(l => decode(l.polyline))) } : null)
    if (!p) setError(why)
  }
  function endTrip() {
    t.endTrip()
    setEnding(false)
    setSheet(false)
    setView('home')
  }

  return (
    <APIProvider apiKey={import.meta.env.GOOGLE_MAPS_BROWSER_KEY}>
      {view === 'settings' ? <Settings onBack={() => setView(back)} />
        : view === 'profile' ? <Profile notes={t.profile} onForget={t.forget} onBack={() => setView(back)} />
        : view === 'planner' ? <Planner onBack={() => setView('home')} onGo={async stops => { const ok = await t.startPlan(stops); if (ok) enter(); return ok }} />
        : view === 'trip' && trip ? (
          <div className="trip">
            <div className="map">
              <TripMap polyline={road} preview={preview?.line ?? null} you={trip.fix} stops={stops} hasDest={!!left}
                fitKey={trip.id + trip.plan.map(e => e.ref) + (preview?.line ? preview.ref : '')}
                picks={picks} selected={selected} onSelect={select} drive={t.live || t.replaying} />
            </div>
            <div className="panel">
              <header className="tripbar">
                <button className="icon-btn" aria-label="Change trip" onClick={() => setView('home')}><Icon name="back" /></button>
                <button className="route" aria-expanded={sheet} aria-controls="plan" onClick={() => { setSheet(!sheet); setEnding(false) }}>
                  <span className="text">
                    {dest ? <>
                      <b>{short(trip.places[trip.origin].name)} → {short(dest.name)}</b>
                      <span>{t.replaying && <span className="live">Replay · </span>}
                        {t.arrived ? 'Arrived' : left ? `${left.min} min · ${left.km} km left` : 'Finding route…'}
                        {stops.length > 0 && ` · ${stops.length} stop${stops.length > 1 ? 's' : ''}`}</span>
                    </> : <><b>Around you</b><span>No destination set</span></>}
                  </span>
                  <Icon name={sheet ? 'up' : 'down'} />
                </button>
                {!!left && (
                  <button className={'icon-btn' + (t.replaying ? ' on' : '')} aria-label={t.replaying ? 'Stop replay' : 'Replay this drive'}
                    aria-pressed={t.replaying} onClick={t.replay}><Icon name={t.replaying ? 'stop' : 'play'} /></button>
                )}
              </header>
              {sheet && (
                <section className="sheet" id="plan">
                  <ol className="plan">
                    <li className="start done"><span className="mark" /><span className="name">{short(trip.places[trip.origin].name)}</span><span className="meta">Start</span></li>
                    {trip.plan.map(e => {
                      const min = t.ahead.find(a => a.ref === e.ref)?.min
                      // The only destination has no ✕: removing it would quietly turn this into a no-destination trip.
                      const removable = !e.reached_at && (e.kind === 'stop' || dests.length > 1)
                      return (
                        <li key={e.ref} className={e.kind + (e.reached_at ? ' done' : '')}>
                          <span className="mark">{e.reached_at && '✓'}</span>
                          <span className="name">{short(trip.places[e.ref].name)}</span>
                          <span className="meta">{e.reached_at ? 'Reached' : min != null ? `${min} min` : ''}</span>
                          {removable && <button className="icon-btn" aria-label={`Remove ${short(trip.places[e.ref].name)}`}
                            disabled={!!busy} onClick={() => t.removeStop(e.ref)}><Icon name="x" /></button>}
                        </li>
                      )
                    })}
                  </ol>
                  {!t.live && (
                    <button className="btn wide quiet" onClick={t.imHere}><Icon name="locate" /> I'm here, use my location</button>
                  )}
                  <form className="next" onSubmit={async ev => { ev.preventDefault(); if (next.pick && await t.whereNext(next.pick)) setNext({ text: '' }) }}>
                    <div className="places"><PlaceInput label="Where next?" place={next} onChange={setNext} /></div>
                    <button className="btn" disabled={!next.pick || !!busy}>Add</button>
                  </form>
                  {ending ? (
                    <div className="confirm" role="alertdialog" aria-label="End this trip?">
                      <p><b>End this trip?</b> The plan and chat are cleared. Profile notes stay.</p>
                      <div className="row-btns">
                        <button className="btn" onClick={() => setEnding(false)}>Keep going</button>
                        <button className="btn danger" onClick={endTrip}>End trip</button>
                      </div>
                    </div>
                  ) : (
                    <div className="row-btns">
                      {mapsLink(trip, trip.plan) && <a className="btn" href={mapsLink(trip, trip.plan)} target="_blank" rel="noreferrer">Open in Maps</a>}
                      <button className="btn quiet danger-text" onClick={() => setEnding(true)}>End trip</button>
                    </div>
                  )}
                  <nav className="sheet-foot">
                    <button className="btn quiet" onClick={() => open('profile')}><Icon name="user" /> Profile</button>
                    <button className="btn quiet" onClick={() => open('settings')}><Icon name="settings" /> Settings</button>
                  </nav>
                </section>
              )}
              {t.arrived && !sheet && (
                <div className="banner" role="status">
                  <p><b>Arrived.</b> Anything next?</p>
                  <button onClick={() => setSheet(true)}>Where next?</button>
                </div>
              )}
              {sos && <a className="sos" href="tel:112"><Icon name="phone" /> Call 112</a>}
              {banner && (
                <div className="banner" role="status">
                  <p>{banner.text}</p>
                  <button onClick={t.tapBanner} disabled={!!busy}>Show options</button>
                  <button className="icon-btn" aria-label="Dismiss" onClick={t.dismissBanner}><Icon name="x" /></button>
                </div>
              )}
              <Chat trip={trip} busy={busy} selected={selected} adding={preview?.ref ?? null} onSelect={select} onSend={ask} onAddStop={addStop} />
              {error && <p className="note" role="alert">{error}</p>}
              {preview ? (
                <div className="preview" role="status">
                  <div className="body">
                    <b>{short(trip.places[preview.ref].name)}</b>
                    <span>{preview.plusMin == null ? 'Checking the route…' : `+${preview.plusMin} min to arrival`}</span>
                  </div>
                  {preview.line && <a className="icon-btn" aria-label="Open in Maps with this stop" title="Open in Maps with this stop"
                    target="_blank" rel="noreferrer" href={mapsLink(trip, withStop(trip.plan, preview.ref))}><Icon name="map" /></a>}
                  <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
                  <button className="btn primary" disabled={preview.plusMin == null || !!busy}
                    onClick={() => { t.confirmStop(preview.ref); setPreview(null) }}>Confirm</button>
                </div>
              ) : <Composer disabled={!!busy} onSend={ask} />}
            </div>
          </div>
        ) : (
          <Landing trip={trip} busy={busy} error={error} onStart={go} onHere={goHere} onContinue={enter}
            onReplay={() => { enter(); if (!t.replaying) t.replay() }} onOpen={open} onPlan={() => setView('planner')} />
        )}
    </APIProvider>
  )
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [input, setInput] = useState('')
  return (
    <form className="composer" onSubmit={e => { e.preventDefault(); const s = input.trim(); if (s && !disabled) { setInput(''); onSend(s) } }}>
      <input value={input} onChange={e => setInput(e.target.value)} placeholder="What do you need?" aria-label="Message" enterKeyHint="send" />
      <button disabled={disabled || !input.trim()} aria-label="Send"><Icon name="send" /></button>
    </form>
  )
}
