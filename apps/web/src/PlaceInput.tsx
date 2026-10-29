import { useEffect, useRef, useState } from 'react'
import { googleProvider, type Suggestion } from '@trippy/core'

export type Place = { text: string; pick?: Suggestion } // what is typed, and the suggestion picked for it

// Text box with Google place suggestions, like the Maps search box. Arrow keys + Enter, or click, to pick.
// Typing again clears the pick, so a trip only ever routes to a real place.
export function PlaceInput({ label, place, onChange }: { label: string; place: Place; onChange: (p: Place) => void }) {
  const [list, setList] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const latest = useRef('')

  useEffect(() => {
    latest.current = place.text
    if (place.pick || place.text.trim().length < 2) return setList([])
    const t = setTimeout(() => googleProvider.autocomplete(place.text)
      .then(s => { if (latest.current === place.text) { setList(s); setActive(0) } })
      .catch(() => setList([])), 250) // one call per pause in typing
    return () => clearTimeout(t)
  }, [place.text, place.pick])

  const pick = (s: Suggestion) => { onChange({ text: s.main, pick: s }); setOpen(false) }
  const keys = (e: React.KeyboardEvent) => {
    if (!open || !list.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % list.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + list.length) % list.length) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(list[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className="place">
      <span className="dot" />
      <input value={place.text} placeholder={label} aria-label={label} aria-autocomplete="list" aria-expanded={open && list.length > 0}
        onKeyDown={keys} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onChange={e => { onChange({ text: e.target.value }); setOpen(true) }} />
      {place.pick && <span className="tick" aria-label="Picked">✓</span>}
      {open && list.length > 0 && (
        <ul className="suggest" role="listbox">
          {list.map((s, i) => (
            <li key={s.placeId} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
              onMouseDown={e => { e.preventDefault(); pick(s) }}>
              <b>{s.main}</b>
              <span>{s.secondary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
