import { useEffect, useRef, useState } from 'react'
import { cards, linksFor, MODELS, RUPEES, type Card as Pick, type How, type Search, type Trip } from '@trippy/core'
import { Icon } from './Icon.tsx'
import { HOW_KEY, modelName } from './Screens.tsx'

const HINTS = ['Veg place within 10 min', "Something like Domino's, max 10 min detour", 'Nearest ATM on the way', 'Bhai chai break kahan milega?']
const STAGES = ['Understand', 'Search', 'Rank']
const PHONE = /Android|iPhone|iPad/i.test(navigator.userAgent) // ponytail: a phone without WhatsApp gets a dead button

// Chat lines, numbered result cards and link buttons. Only the latest answer with places has cards that match the pins and can be tapped.
// Messages point at a search (cards) or a link ref (buttons); both are read from the trip, never copied.
// adding = the ref whose add-stop preview is open. Cards fold to name + minutes; only the latest answer's are open by default.
export function Chat({ trip, busy, selected, adding, onSelect, onSend, onAddStop }: { trip: Trip; busy: string; selected: string | null;
  adding: string | null; onSelect: (id: string) => void; onSend: (text: string) => void; onAddStop: (ref: string) => void }) {
  const end = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({}) // search id -> the user's fold choice
  const lines = trip.messages.map(m => ({ ...m, picks: cards(trip, m.search), links: m.link ? linksFor(trip, m.link) : undefined,
    asOf: asOf(trip.searches.find(s => s.id === m.search)?.at) }))
  const latest = lines.findLast(l => l.picks?.length) // follow-up text answers keep these cards live and their pins up
  const showHow = localStorage.getItem(HOW_KEY) === '1' // Settings sits on its own screen: Chat remounts after a change
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [lines.length, busy])

  return (
    <div className="chat" aria-live="polite">
      {!lines.length && !busy && (
        <div className="welcome">
          <h2 className="h">What does the car need?</h2>
          <p className="muted">Food, a washroom, fuel, an ATM. Say it how you'd say it to the driver.</p>
          <div className="chips">
            {HINTS.map(h => <button key={h} className="chip" onClick={() => onSend(h)}>{h}</button>)}
          </div>
        </div>
      )}
      {lines.map((l, i) => {
        const live = l === latest
        const unfolded = open[l.search!] ?? live
        return (
          <div key={i} className={`msg ${l.role}` + (l.picks?.length || l.links ? ' answer' : '')}>
            {l.text && <p>{l.text}</p>}
            {!!l.picks?.length && (
              <div className={'cards' + (unfolded ? '' : ' folded')}>
                {l.picks.map((p, j) => (
                  <div key={p.ref} className="pick">
                    <Card p={p} n={j + 1} asOf={l.asOf} live={live} on={live && p.place_id === selected} onSelect={onSelect} />
                    {live && (trip.plan.some(e => e.ref === p.ref)
                      ? <span className="add added"><Icon name="check" /> Added</span>
                      : <button className={'add' + (adding === p.ref ? ' on' : '')} aria-pressed={adding === p.ref}
                          onClick={() => onAddStop(p.ref)} disabled={!!busy}><Icon name="plus" /> Add stop</button>)}
                  </div>
                ))}
                <button className="fold" aria-expanded={unfolded} onClick={() => setOpen({ ...open, [l.search!]: !unfolded })}>
                  {unfolded ? 'Fewer details' : 'More details'} <Icon name={unfolded ? 'up' : 'down'} />
                </button>
              </div>
            )}
            {l.links && (
              <div className="links">
                <a className="btn" href={l.links.maps} target="_blank" rel="noreferrer">Open in Maps</a>
                <a className="btn" href={l.links.uber} target="_blank" rel="noreferrer">Uber</a>
                {/* Phones open the WhatsApp app directly (wa.me opens a web page first inside the installed PWA). */}
                <a className="btn" href={PHONE ? l.links.whatsapp_app : l.links.whatsapp} target="_blank" rel="noreferrer">WhatsApp</a>
              </div>
            )}
            {showHow && l.how && <Decided trip={trip} how={l.how} search={trip.searches.find(s => s.id === l.search)} />}
          </div>
        )
      })}
      {busy && <Steps busy={busy} />}
      <div ref={end} />
    </div>
  )
}

function Card({ p, n, asOf, live, on, onSelect }: { p: Pick; n: number; asOf: string; live: boolean; on: boolean; onSelect: (id: string) => void }) {
  const cls = 'card' + (live ? ' live' : ' old') + (on ? ' selected' : '')
  const body = (
    <>
      <span className="n">{n}</span>
      <span className="body">
        <span className="name">{p.name}</span>
        <span className="meta">
          {p.min} min{p.from_dest && ' from destination'}{asOf}{p.detour_min != null && ` · +${p.detour_min} detour`}
          <span className="extra">{p.rating != null && ` · ${p.rating}★ (${count(p.reviews ?? 0)})`}
            {p.price && RUPEES[p.price] && ` · ${RUPEES[p.price]}`}</span>
          {p.open_now === false && <> · <span className="closed">closed now</span></>}
        </span>
        {p.reason && <span className="why">{p.reason}</span>}
      </span>
    </>
  )
  return live
    ? <button id={p.place_id!} className={cls} aria-pressed={on} onClick={() => onSelect(p.place_id!)}>{body}</button>
    : <div className={cls}>{body}</div>
}

// The agent reports progress as text: "Thinking…" -> "Searching …" -> "Ranking N places…". Map it to three steps.
function Steps({ busy }: { busy: string }) {
  const stage = /^Ranking/.test(busy) ? 2 : /^Searching/.test(busy) ? 1 : 0
  return (
    <div className="msg assistant steps" role="status">
      <ol>{STAGES.map((s, i) => <li key={s} className={i < stage ? 'done' : i === stage ? 'now' : ''}>{s}</li>)}</ol>
      <p>{busy}</p>
    </div>
  )
}

// "How Trippy decided" (FEATURES #25): a one-line summary that opens to models, tools, places and time. Everything comes from what
// the turn recorded (message.how) and its search; nothing is asked of a model.
const ROLE: Record<string, string> = { pick: 'picked the tools', plan: 'planned it, reasoning on', rank: 'ranked the places' }
const LIMIT: Record<string, (m: number) => string> = { from_now: m => `within ${m} min from now`, detour: m => `max ${m} min detour`,
  near_destination: m => `within ${m} min of the destination` }
const WHERE: Record<string, string> = { from_now: 'nearby', detour: 'along the route', near_destination: 'near the destination' }
const model = (t: string) => t in MODELS ? MODELS[t as keyof typeof MODELS].model : t
const tierName = (t: string) => modelName(model(t)).replace('Nemotron ', '') + (t === 'plan' ? ' (reasoning)' : '')
const plural = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`

function Decided({ trip, how, search }: { trip: Trip; how: How; search?: Search }) {
  const tools = how.steps.filter(s => s.name !== 'reply')
  const tiers = [...new Set(how.models)]
  const line = [tiers.filter(t => t !== 'rank').map(tierName).join(' + '), [...new Set(tools.map(s => s.name))].join(', ') || 'answered',
    search && `${tiers.includes('rank') ? tierName('rank') + ' ' : ''}ranked ${search.candidates.length} → ${search.picks.length}`]
  const place = (r: unknown) => r === 'destination' ? 'the destination' : trip.places[String(r)]?.name.split(',')[0] ?? String(r ?? '')
  const args = ({ name, args: a }: How['steps'][number]) => {
    if (name === 'find_stops') return [`"${a.need}"`, a.similar_to && !/^\s*(none|null|n\/a|-)?\s*$/i.test(a.similar_to) && `like "${a.similar_to}"`,
      LIMIT[a.limit_type]?.(a.limit_min), a.places?.length && `named ${a.places.join(', ')}`].filter(Boolean).join(', ')
    if (name === 'eta_from_here') return `to ${place(a.ref ?? 'destination')}${a.from === 'destination' ? ' from the destination' : ''}` +
      (Date.parse(a.depart_at) ? `, leaving ${clock(a.depart_at)}` : '')
    if (name === 'place_details' || name === 'make_link') return place(a.ref)
    if (name === 'web_search') return `"${a.query}"`
    if (name === 'remember') return `"${a.note}"`
    return name === 'get_trip_state' ? String(a.section ?? '').replace('_', ' ') : ''
  }
  return (
    <details className="how">
      <summary><Icon name="down" />{line.filter(Boolean).join(' → ')} · {(how.ms / 1000).toFixed(1)} s</summary>
      <dl>
        <dt>Models</dt>
        <dd>{tiers.map(t => (
          <span key={t}><b>{t in MODELS ? modelName(model(t)) : 'Your own key'}</b> {ROLE[t] ?? 'did every step'} · {plural(how.models.filter(m => m === t).length, 'call')}
            <small>{model(t)}{t in MODELS && ' on Nebius Token Factory'}</small></span>
        ))}</dd>
        <dt>Tools</dt>
        <dd>{tools.length ? tools.map((s, i) => <span key={i}><code>{s.name}</code> {args(s)}</span>) : <span>None: answered from the trip so far</span>}</dd>
        {search && <><dt>Places</dt><dd><span>{plural(search.candidates.length, 'place')} found {WHERE[search.args.limit_type]}, {search.picks.length} shown</span></dd></>}
        <dt>Time</dt>
        <dd><span>{(how.ms / 1000).toFixed(1)} s · {plural(how.models.length, 'model call')} · {plural(how.maps, 'map call')}</span></dd>
      </dl>
    </details>
  )
}

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
// Card minutes are from where the search ran; past 2 min say when (ride: "2 min" 28 min and 9 km later).
const asOf = (at?: string) => at && Date.now() - Date.parse(at) > 120_000
  ? ` · as of ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
const count = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)
