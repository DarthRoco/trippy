import { useEffect, useState } from 'react'
import { load, remove, save } from './store.ts'
import { MODELS, byo, type Note, type Trip } from '@trippy/core'
import { Icon } from './Icon.tsx'
import { PlaceInput, type Place } from './PlaceInput.tsx'
import { exportLog, exportTrace } from './log.ts'

function Head({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="screen-head">
      <button className="icon-btn" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
      <h1 className="h">{title}</h1>
    </div>
  )
}

// Landing: start a trip from two picked places or around the current position (G2), or replay a drive (H3).
// Replay drives the current trip's route (a fake trace until the recorded Kurla -> Juhu ride exists).
export function Landing({ trip, busy, error, onStart, onHere, onContinue, onReplay, onOpen, onPlan }: {
  trip: Trip | null; busy: string; error: string
  onStart: (from: Place, to: Place) => void; onHere: () => void; onContinue: () => void; onReplay: () => void
  onOpen: (v: 'settings' | 'profile') => void; onPlan: () => void
}) {
  const [from, setFrom] = useState<Place>({ text: '' })
  const [to, setTo] = useState<Place>({ text: '' })
  const [replayNote, setReplayNote] = useState(false)
  const ready = !!from.pick && !!to.pick
  const dest = trip && trip.places[trip.plan.findLast(e => e.kind === 'destination')?.ref ?? '']

  return (
    <main className="screen">
      <h1 className="wordmark h">trippy<span>.</span></h1>
      <p className="tagline">Tell it what the car needs. It finds real places on your route.</p>
      {trip && (
        <button className="btn wide" onClick={onContinue}>{dest ? `Continue trip to ${dest.name.split(',')[0]}` : 'Continue around you'}</button>
      )}
      <form className="section" onSubmit={e => { e.preventDefault(); if (ready) onStart(from, to) }}>
        <div className="places">
          <PlaceInput label="From" place={from} onChange={setFrom} />
          <PlaceInput label="To" place={to} onChange={setTo} />
        </div>
        <button className="btn primary wide" disabled={!!busy}>{busy || 'Start trip'}</button>
        {!ready && (from.text || to.text) && <p className="note">Pick both places from the suggestions.</p>}
        {error && <p className="note" role="alert">{error}</p>}
        <button type="button" className="btn wide quiet" disabled={!!busy} onClick={onHere}>
          <Icon name="locate" /> No destination? Search around me
        </button>
      </form>
      <button className="btn wide" onClick={() => trip?.route ? onReplay() : setReplayNote(true)}>
        <Icon name="play" /> Replay a drive
      </button>
      {replayNote && <p className="note">Start a trip first, then replay drives it for you.</p>}
      {/* The second option: plan an outing before leaving (Planner.tsx). Independent of the trip above. */}
      <section className="section">
        <h2>Not on the road yet?</h2>
        <button className="btn wide" onClick={onPlan}><Icon name="map" /> Plan an outing</button>
        <p>Say what you want to do. It builds a timed plan from real places, with opening hours and travel times checked.</p>
      </section>
      <nav className="landing-foot">
        <button className="btn" onClick={() => onOpen('profile')}><Icon name="user" /> Profile</button>
        <button className="btn" onClick={() => onOpen('settings')}><Icon name="settings" /> Settings</button>
      </nav>
    </main>
  )
}

// What each model call does. Read from the one MODELS config, so this never drifts from the code (H1).
const TIERS: { key: keyof typeof MODELS; job: string }[] = [
  { key: 'pick', job: 'Reads your request and picks the search' },
  { key: 'rank', job: 'Ranks the real places found and says why' },
  { key: 'plan', job: 'Planning and sightseeing questions' },
]
export const modelName = (id: string) => {
  const size = /nano|super|ultra/i.exec(id)?.[0]
  return size ? `Nemotron ${size[0].toUpperCase()}${size.slice(1).toLowerCase()}` : id.split('/').pop()!
}

// "How Trippy decided" under each answer (FEATURES #25): off by default, a display choice kept on this device. Chat reads it.
export const HOW_KEY = 'trippy-show-how'

export function Settings({ onBack }: { onBack: () => void }) {
  const [note, setNote] = useState('')
  const [how, setHow] = useState(() => localStorage.getItem(HOW_KEY) === '1')
  const save = (run: () => Promise<boolean>, none: string) => run().then(ok => setNote(ok ? 'Saved to Downloads.' : none))
  return (
    <main className="screen">
      <Head title="Settings" onBack={onBack} />
      <section className="section">
        <h2>Models</h2>
        <p>Each step uses the model that fits it, on Nebius Token Factory.</p>
        <div className="rows">
          {TIERS.map(({ key, job }) => (
            <div className="row" key={key}>
              <div className="body"><b>{modelName(MODELS[key].model)}</b><span>{job}</span></div>
              <span className={'tag' + (MODELS[key].think ? ' on' : '')}>{MODELS[key].think ? 'reasoning on' : 'fast'}</span>
            </div>
          ))}
          <label className="row switch">
            <div className="body"><b>Show how Trippy decided</b><span>Under each answer: models, tools, places found and time</span></div>
            <input type="checkbox" role="switch" checked={how}
              onChange={e => { setHow(e.target.checked); localStorage.setItem(HOW_KEY, e.target.checked ? '1' : '0') }} />
          </label>
        </div>
      </section>
      <OwnKey />
      <section className="section">
        <h2>Data</h2>
        <div className="rows">
          <div className="row"><div className="body"><b>Google Maps Platform</b><span>Routes, places, ratings, opening hours</span></div></div>
          <div className="row"><div className="body"><b>Tavily</b><span>Web search for follow-up questions</span></div></div>
        </div>
      </section>
      <section className="section">
        <h2>Debug</h2>
        <p>A log of the current trip (calls, answers, positions), kept on this device. Saved as a file you can share.</p>
        <button className="btn wide" onClick={() => save(exportLog, 'Nothing logged yet.')}>Export debug log</button>
        <button className="btn wide" onClick={() => save(exportTrace, 'No GPS positions recorded on this trip.')}>Export trace</button>
        {note && <p role="status">{note}</p>}
      </section>
      <section className="section">
        <h2>Privacy</h2>
        <p>Your trip, chat and notes stay on this phone. Our relay passes requests through and doesn't store or log them.</p>
      </section>
    </main>
  )
}

// Bring-your-own key (FEATURES #1): any OpenAI-compatible endpoint, saved only on this phone (IndexedDB 'settings').
// llm.ts reads `byo` on every call; an empty key = the hosted default. Applied at startup (main.tsx), on Save and on Clear.
export type OwnKeySettings = { base_url: string; key: string; model: string }
export const applyKey = (s?: OwnKeySettings) =>
  Object.assign(byo, { base: s?.base_url.trim() ?? '', key: s?.key.trim() ?? '', model: s?.model.trim() ?? '' })

function OwnKey() {
  const [s, setS] = useState<OwnKeySettings>({ base_url: '', key: '', model: '' })
  const [note, setNote] = useState('')
  useEffect(() => { load<OwnKeySettings>('settings').then(v => v && setS(v)).catch(() => {}) }, [])
  const field = (k: keyof OwnKeySettings) => ({ value: s[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setS({ ...s, [k]: e.target.value }); setNote('') } })
  const ready = !!(s.base_url.trim() && s.key.trim() && s.model.trim())
  return (
    <form className="section" onSubmit={e => { e.preventDefault(); if (ready) save('settings', s).then(() => { applyKey(s); setNote('Saved on this phone.') }) }}>
      <h2>Your own key</h2>
      <p>Optional. Any OpenAI-compatible API. Calls then go straight from this phone to it, for every step. Leave empty to use ours.</p>
      <div className="fields">
        <label>Base URL<input {...field('base_url')} type="url" inputMode="url" placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false} /></label>
        <label>API key<input {...field('key')} type="password" placeholder="sk-…" autoComplete="off" spellCheck={false} /></label>
        <label>Model<input {...field('model')} placeholder="gpt-4.1-mini" autoComplete="off" spellCheck={false} /></label>
      </div>
      <div className="row-btns">
        <button type="button" className="btn" onClick={() => { setS({ base_url: '', key: '', model: '' }); applyKey(); remove('settings').then(() => setNote('Using the hosted models.')) }}>Clear</button>
        <button className="btn primary" disabled={!ready}>Save</button>
      </div>
      {note && <p role="status">{note}</p>}
    </form>
  )
}

// Profile notes the model saved with remember(scope=profile). Delete is done by code (SHOULD #15, G3).
export function Profile({ notes, onForget, onBack }: { notes: Note[]; onForget: (id: string) => void; onBack: () => void }) {
  return (
    <main className="screen">
      <Head title="Profile" onBack={onBack} />
      <section className="section">
        <h2>What Trippy remembers</h2>
        <p>Things you asked it to keep, like "dad is vegetarian". Used on every trip.</p>
        <div className="rows">
          {notes.length ? notes.map(n => (
            <div className="row" key={n.id}>
              <div className="body">{n.text}</div>
              <button className="icon-btn" aria-label={`Delete "${n.text}"`} onClick={() => onForget(n.id)}><Icon name="trash" /></button>
            </div>
          )) : <div className="empty">Nothing saved yet. Tell Trippy "remember that dad is vegetarian" during a trip.</div>}
        </div>
      </section>
    </main>
  )
}
