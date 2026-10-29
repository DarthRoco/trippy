import { Component, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Map, AdvancedMarker, useMap } from '@vis.gl/react-google-maps'
import { decode, type Card as Pick, type LatLng } from '@trippy/core'
import { Icon } from './Icon.tsx'

// fitKey: the map refits when it changes (new trip, plan, picks or preview), not on every GPS / replay step.
// preview: the add-stop route (never stored), drawn dashed over the faded current route.
// drive: the trip is live or replaying; the map then follows the car until the user pans or zooms.
type Props = { polyline: string; preview: string | null; you: LatLng; stops: LatLng[]; hasDest: boolean; fitKey: string
  picks: Pick[]; selected: string | null; onSelect: (id: string) => void; drive: boolean }

// A map failure (bad key, blocked referrer, no network) leaves the chat and cards working.
export class TripMap extends Component<Props, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render(): ReactNode {
    return this.state.failed ? <p className="map-off">Map unavailable. Results below still work.</p> : <MapView {...this.props} />
  }
}

// A map's colour scheme is fixed when it is created, so the map is recreated when the device theme changes.
const scheme = matchMedia('(prefers-color-scheme: dark)')
const useDark = () => useSyncExternalStore(f => { scheme.addEventListener('change', f); return () => scheme.removeEventListener('change', f) }, () => scheme.matches)

// Map with the route, start / end markers, confirmed stops and numbered pins matching the cards (Q13).
function MapView({ onSelect, drive, ...p }: Props) {
  const dark = useDark()
  const [follow, setFollow] = useState(drive)
  useEffect(() => setFollow(drive), [drive])
  return (
    <>
    <Map key={dark ? 'dark' : 'light'} defaultCenter={{ lat: 19.08, lng: 72.86 }} defaultZoom={12} mapId="DEMO_MAP_ID" colorScheme="FOLLOW_SYSTEM"
      disableDefaultUI gestureHandling="greedy">
      <RouteView {...p} follow={follow} setFollow={setFollow} />
      {p.stops.map((s, i) => (
        <AdvancedMarker key={i} position={s} title="Stop" zIndex={4}><div className="endpoint stop" /></AdvancedMarker>
      ))}
      {p.picks.map((c, i) => (
        <AdvancedMarker key={c.ref} position={c.location} title={c.name} onClick={() => onSelect(c.place_id!)}
          zIndex={c.place_id === p.selected ? 10 : 1}>
          <div className={'pin' + (c.place_id === p.selected ? ' on' : '')}><b>{i + 1}</b></div>
        </AdvancedMarker>
      ))}
    </Map>
    {drive && !follow && (
      <button className="recenter" aria-label="Follow the car" title="Follow the car" onClick={() => setFollow(true)}><Icon name="locate" /></button>
    )}
    </>
  )
}

// Route ahead with a position marker and the destination. Following: centred on the car at street zoom. Otherwise the map
// fits the route (or the preview) plus the current picks (or centres on the position when there is no destination).
// New picks or a preview stop following so they are seen; so do a pan, a zoom or a selected pick (the map pans to it).
function RouteView({ polyline, preview, you, hasDest, fitKey, picks, selected, follow, setFollow }: Omit<Props, 'onSelect' | 'stops' | 'drive'>
  & { follow: boolean; setFollow: (on: boolean) => void }) {
  const map = useMap()
  const path = useMemo(() => decode(polyline), [polyline])
  const alt = useMemo(() => (preview ? decode(preview) : null), [preview])
  const ids = picks.map(p => p.place_id).join()
  const pickKey = fitKey + ids
  const following = useRef(follow)
  following.current = follow
  const seen = useRef({ ids, alt })

  useEffect(() => {
    if (!map) return
    const color = getComputedStyle(document.documentElement).getPropertyValue('--route').trim() // follows light / dark
    const line = new google.maps.Polyline({ path, map, strokeColor: color, strokeOpacity: alt ? 0.3 : 0.9, strokeWeight: 5 })
    // Dashes = a repeated line symbol on an invisible stroke (the Maps JS way).
    const dash = alt && new google.maps.Polyline({ path: alt, map, strokeOpacity: 0, zIndex: 2,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeColor: color, strokeOpacity: 1, strokeWeight: 4, scale: 3 }, offset: '0', repeat: '14px' }] })
    return () => { line.setMap(null); dash?.setMap(null) }
  }, [map, path, alt])

  useEffect(() => {
    if (!map) return
    const fresh = (ids && ids !== seen.current.ids) || (alt && alt !== seen.current.alt)
    seen.current = { ids, alt }
    if (fresh) { following.current = false; setFollow(false) }
    const fit = () => {
      if (following.current) return // plan changes keep following
      if (!hasDest && !picks.length && !alt) { map.setCenter(you); map.setZoom(15); return } // no-destination trip (G2)
      const bounds = new google.maps.LatLngBounds()
      if (hasDest) path.forEach(p => bounds.extend(p))
      else bounds.extend(you)
      alt?.forEach(p => bounds.extend(p))
      picks.forEach(p => bounds.extend(p.location))
      map.fitBounds(bounds, 40)
    }
    fit()
    // Refit when the width changes (rotation, window resize). Width only: the phone keyboard changes the height.
    let width = innerWidth // ponytail: a resize while following waits for the next fix to re-centre
    const onResize = () => { if (innerWidth !== width) { width = innerWidth; fit() } }
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [map, pickKey])

  useEffect(() => {
    const p = picks.find(p => p.place_id === selected)
    if (map && p) { setFollow(false); map.panTo(p.location) }
  }, [map, selected])

  useEffect(() => {
    if (map && follow) { map.setZoom(16); map.setCenter(you) }
  }, [map, follow])
  useEffect(() => {
    if (map && follow) map.panTo(you)
  }, [you.lat, you.lng])

  // User gestures stop following. dragstart is user-only; zoom_changed also fires for code, so wheel / pinch / double-tap instead.
  useEffect(() => {
    if (!map) return
    const off = () => setFollow(false)
    const pinch = (e: TouchEvent) => { if (e.touches.length > 1) off() }
    const div = map.getDiv(), opts = { capture: true, passive: true }
    const drag = map.addListener('dragstart', off)
    div.addEventListener('wheel', off, opts)
    div.addEventListener('dblclick', off, opts)
    div.addEventListener('touchstart', pinch, opts)
    return () => { drag.remove(); div.removeEventListener('wheel', off, opts); div.removeEventListener('dblclick', off, opts); div.removeEventListener('touchstart', pinch, opts) }
  }, [map])

  return (
    <>
      <AdvancedMarker position={you} title="You" zIndex={5}><div className="endpoint" /></AdvancedMarker>
      {hasDest && <AdvancedMarker position={path[path.length - 1]} title="Destination"><div className="endpoint dest" /></AdvancedMarker>}
    </>
  )
}
