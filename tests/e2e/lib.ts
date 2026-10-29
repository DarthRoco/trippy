// E2E helpers (spec: bus E2E.md). The app's state is read from its own IndexedDB (trip, profile, debug log); every wait
// polls that state, never a fixed sleep. Actions press the same buttons a person would. Never taps 112, tel:, Uber or
// WhatsApp links: those only get their hrefs read.
import type { BrowserContext, Page } from '@playwright/test'
import { cards, decode, istIso, legsAhead, MODELS, offRoute, type LatLng, type Message, type Note, type Trip } from '@trippy/core'

export type Ev = { trip: string; t: number; type: string; data: any }
export type Doc = { trip: Trip | null; profile: Note[] }
export type F = { page: Page; ctx: BrowserContext; base: string; errors: string[]; ms?: number }
// What a check sees after its step: the doc now and before, this step's log events, the screen text, the run's result.
export type View = Doc & { f: F; before: Doc; log: Ev[]; text: string; out: any; added: Message[] }
// true = pass; skip(why) = does not apply now (passes, and the summary says why); anything else = fail, shown as the detail
export type Check = [name: string, ok: (v: View) => unknown]
export const skip = (why: string) => ({ skip: why })
export const skipped = (v: unknown): v is { skip: string } => typeof v === 'object' && v !== null && 'skip' in v
export type Step = { say: string; run: (f: F, d: Doc) => Promise<unknown>; c?: Check[]; j?: string }
export type Flow = { id: string; title: string; geo?: LatLng; phone?: boolean; steps: Step[] }

// --- State ---

const idb = <T,>(page: Page, db: string, store: string, all = false) => page.evaluate(([db, store, all]) =>
  new Promise<T | null>(res => {
    const r = indexedDB.open(db)
    r.onerror = () => res(null)
    r.onsuccess = () => {
      const d = r.result
      if (!d.objectStoreNames.contains(store)) { d.close(); return res(null) }
      const os = d.transaction(store).objectStore(store)
      const g = all ? os.getAll() : os.get('active')
      g.onsuccess = () => { d.close(); res(g.result ?? null) }
      g.onerror = () => { d.close(); res(null) }
    }
  }), [db, store, all] as const)

export async function read(f: F): Promise<Doc> {
  const [trip, p] = await Promise.all([idb<Trip>(f.page, 'trippy', 'trip'), idb<{ notes: Note[] }>(f.page, 'trippy', 'profile')])
  return { trip, profile: p?.notes ?? [] }
}
export const events = async (f: F) => (await idb<Ev[]>(f.page, 'trippy-log', 'events', true)) ?? []

// Polls the state until pred is truthy. A read that fails mid-navigation just tries again.
export async function until<T>(f: F, pred: (d: Doc) => T | Promise<T>, what: string, ms = 60_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const d = await read(f).catch(() => null)
    const v = d && await pred(d)
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`)
    await f.page.waitForTimeout(200) // the poll interval, not a wait for the app
  }
}

// --- Facts about the trip, shared by flows and checks ---

export const short = (name: string) => name.split(',')[0]
export const unreached = (t: Trip) => t.plan.filter(e => !e.reached_at)
// The route's legs are exactly the unreached plan entries, in plan order (a route written after the last plan change).
// legsAhead() drops a leg to an entry the plan no longer has, so after a ✕ the old route looks settled until the
// Compute Routes call returns (F6 5 read "3 legs" 105 ms after the ✕): a leg to a removed entry counts as not settled.
export const settled = (t: Trip | null) => !!t && legsAhead(t).map(l => l.to).join() === unreached(t).map(e => e.ref).join() &&
  (t.route ?? []).every(l => t.plan.some(e => e.ref === l.to))
export const latest = (t: Trip) => cards(t, t.messages.findLast(m => m.search)?.search)
export const used = (v: View, name: string) => v.log.some(e => e.type === 'answer' && e.data.steps?.some((s: any) => s.name === name))
export const live = (f: F) => f.page.locator('.card.live')

// The link buttons of the newest link message among `added`: '' when they are for the place asked about, else why not.
// `want` is a ref or a name pattern; `hrefs` are the buttons' hrefs (Open in Maps, Uber, ...). Pure, so links.check.ts
// can run it on a saved bundle (#60: Open in Maps went to Sassoon Dock Clock Tower while the message said Leopold).
export function linkProblem(t: Trip, added: Message[], want: string | RegExp, [maps, uber]: string[]): string {
  const m = added.findLast(m => m.link)
  if (!m) return 'no link message was added'
  const p = t.places[m.link!]
  if (typeof want === 'string' ? m.link !== want : !want.test(p.name)) return `the links are for ${p.name} (${m.link})`
  return [
    p.place_id && !maps?.includes(`destination_place_id=${p.place_id}`) && `Open in Maps does not hold ${p.name}'s place id`,
    !uber?.includes(`dropoff[nickname]=${encodeURIComponent(p.name)}`) && `Uber is not for ${p.name}`,
  ].filter(Boolean).join('; ')
}

// --- What a reply says ---

// Announcing work in a reply: "let me check", "I'll find one fast", "I’ll search" (curly apostrophe too).
export const ANNOUNCES = /\b(?:let me|i['’]ll|i will|i am going to|i['’]m going to) (?:check|look|find|search|get|fetch)\b/i
// Raw field values: price enums, snake_case names (serves_veg, open_now), "key: true / false / null / none", bare null.
// Plain "true" / "none" are not flagged on their own: "none of them is open" is a normal sentence.
export const RAW = /\b(?:INEXPENSIVE|MODERATE|EXPENSIVE|VERY_EXPENSIVE|PRICE_LEVEL_\w+)\b|\bserves_\w+|\b[a-z]+(?:_[a-z]+)+\b|[:=]\s*["'`]?(?:true|false|null|none)\b|\b(?:null|undefined)\b/

// Minutes a text states: "35 min", "1 hr 5 min", "2 hours". Bare "m" is left out (metres).
export function minutesIn(text: string): number[] {
  const re = /(\d+)\s*(?:h|hrs?|hours?)\b(?:\s*(?:and\s*)?(\d+)\s*(?:mins?|minutes?)\b)?|(\d+)\s*(?:mins?|minutes?)\b/gi
  return [...text.matchAll(re)].map(m => m[3] ? +m[3] : +m[1] * 60 + +(m[2] ?? 0))
}
// Times of day a text states, as minutes after midnight: "7:42 am", "7 pm", "19:05".
export function clockIn(text: string): number[] {
  const re = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi
  return [...text.matchAll(re)].map(m => m[3]
    ? (+m[1] % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + +(m[2] ?? 0)
    : +m[4] * 60 + +m[5])
}
export const istClock = (ms: number) => Math.floor(((ms + 5.5 * 3_600_000) / 60_000) % 1440)
export const clockGap = (a: number, b: number) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d) }
export const istNow = (ms = Date.now()) => istIso(ms).replace('T', ' ').slice(0, 16) + ' IST'

// --- Calls: the same count per step, per flow and per run (cost review) ---

export type Counts = { llm: { super: number; ultra: number; ultra_reasoning: number }; maps: Record<string, number>; tavily: number }
export const noCounts = (): Counts => ({ llm: { super: 0, ultra: 0, ultra_reasoning: 0 }, maps: {}, tavily: 0 })
export function counts(log: Ev[]): Counts {
  const c = noCounts()
  for (const { type, data: d } of log) {
    if (type !== 'call') continue
    if (d.path === '/llm') c.llm[d.body?.model === MODELS.pick.model ? 'super' : d.body?.chat_template_kwargs?.enable_thinking ? 'ultra_reasoning' : 'ultra']++
    else if (d.path === '/search') c.tavily++
    else if (String(d.path).startsWith('/maps/')) c.maps[d.path.slice(6)] = (c.maps[d.path.slice(6)] ?? 0) + 1
  }
  return c
}
export function sumCounts(all: Counts[]): Counts {
  const s = noCounts()
  for (const c of all) {
    for (const k of Object.keys(s.llm) as (keyof Counts['llm'])[]) s.llm[k] += c.llm[k]
    for (const [k, n] of Object.entries(c.maps)) s.maps[k] = (s.maps[k] ?? 0) + n
    s.tavily += c.tavily
  }
  return s
}
// A turn that used the planning tier (Ultra with reasoning) is allowed the long answer time.
export const planned = (log: Ev[]) => log.some(e => e.type === 'call' && e.data.path === '/llm' && e.data.body?.chat_template_kwargs?.enable_thinking)

// Point at a fraction of the road ahead; and a point ~500 m off it that the app counts as off-route.
export const along = (t: Trip, frac: number): LatLng => {
  const pts = legsAhead(t).flatMap(l => decode(l.polyline))
  return pts[Math.floor((pts.length - 1) * frac)]
}
export function offBy(t: Trip, p: LatLng, dKm = 0.5): LatLng {
  const d = dKm / 111
  const q = [{ ...p, lat: p.lat + d }, { ...p, lat: p.lat - d }, { ...p, lng: p.lng + d }, { ...p, lng: p.lng - d }]
    .find(q => offRoute({ ...t, fix: { ...q, t: '' } }))
  if (!q) throw new Error('no point 500 m off the route')
  return q
}

// v2 document rules (E2E.md): refs resolve, no two refs share a place, searches exist. `seen` is every ref's place_id
// from earlier steps, so a ref reused for another place shows up. Route legs = unreached entries is checked by settled().
export function problems(t: Trip, seen: Record<string, string | null>): string[] {
  const out: string[] = []
  const has = (ref: string, where: string) => { if (!t.places[ref]) out.push(`${where}: ${ref} is not in places`) }
  t.plan.forEach(e => has(e.ref, 'plan'))
  t.route?.forEach(l => has(l.to, 'route'))
  t.searches.forEach(s => { s.candidates.forEach(c => has(c.ref, `${s.id} candidate`)); s.picks.forEach(p => has(p.ref, `${s.id} pick`)) })
  t.messages.forEach(m => {
    if (m.search && !t.searches.some(s => s.id === m.search)) out.push(`message points at missing search ${m.search}`)
    if (m.link) has(m.link, 'message link')
  })
  const ids = Object.values(t.places).map(p => p.place_id).filter(Boolean)
  if (new Set(ids).size < ids.length) out.push('two refs share a place_id')
  for (const [ref, p] of Object.entries(t.places)) {
    if (ref in seen && seen[ref] !== p.place_id) out.push(`${ref} was ${seen[ref]}, now ${p.place_id}: ref reused`)
    seen[ref] = p.place_id
  }
  if (!settled(t)) out.push('route legs are not the unreached plan entries')
  return out
}

// --- Actions ---

const sheetButton = (f: F) => f.page.locator('button.route')

export async function open(f: F) {
  await f.page.goto(f.base + '/?replay=60') // 60x replay speed
  await f.page.locator('.tripbar, input[aria-label="From"]').first().waitFor()
}

// What to type, the exact main text of the suggestion to take, and what its secondary text must match (several share a
// main text, "MG Road" in four cities). The first option matching both is clicked, so every run makes the same trip.
export type Pick = [typed: string, main: string, near?: RegExp]

async function pickPlace(f: F, label: string, [typed, main, near]: Pick) {
  await f.page.getByRole('textbox', { name: label, exact: true }).fill(typed)
  let opt = f.page.getByRole('option').filter({ has: f.page.locator('b', { hasText: new RegExp(`^${main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
  if (near) opt = opt.filter({ has: f.page.locator('span', { hasText: near }) })
  try { await opt.first().click({ timeout: 15_000 }) } catch {
    const shown = await f.page.getByRole('option').allInnerTexts().catch(() => [])
    throw new Error(`no suggestion "${main}"${near ? ` with ${near}` : ''} for "${typed}"; shown: ${shown.join(' / ')}`)
  }
  await f.page.locator(`.place:has(input[aria-label="${label}"]) .tick`).waitFor()
}

// Start from two picked suggestions, then wait for the trip document.
export async function start(f: F, from: Pick, to: Pick) {
  if (f.page.url() === 'about:blank') await open(f)
  await pickPlace(f, 'From', from)
  await pickPlace(f, 'To', to)
  await f.page.getByRole('button', { name: 'Start trip' }).click()
  await until(f, d => d.trip?.route, 'the trip to start')
}

export async function startHere(f: F) {
  if (f.page.url() === 'about:blank') await open(f)
  await f.page.getByRole('button', { name: /Search around me/ }).click()
  await until(f, d => d.trip, 'the trip to start')
}

export async function openSheet(f: F) {
  if ((await sheetButton(f).getAttribute('aria-expanded')) !== 'true') await sheetButton(f).click()
}

// Sends text and returns how many messages there were; answered() then waits for the reply.
export async function say(f: F, text: string) {
  const n = (await read(f)).trip!.messages.length
  await f.page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await f.page.getByRole('button', { name: 'Send', exact: true }).click()
  return n
}
export async function answered(f: F, n: number) {
  const t0 = Date.now()
  await until(f, d => { const m = d.trip!.messages; return m.length >= n + 2 && m.at(-1)!.role === 'assistant' }, 'an answer', 150_000)
  f.ms = Math.max(f.ms ?? 0, Date.now() - t0) // the slowest answer of the step
}
export const send = async (f: F, text: string) => answered(f, await say(f, text))

export async function tapBanner(f: F) {
  const n = (await read(f)).trip!.messages.length
  await f.page.getByRole('button', { name: 'Show options' }).click()
  await answered(f, n)
}

// Add stop on card i: returns the "+N min to arrival" text shown before Confirm.
export async function addStop(f: F, i: number) {
  await f.page.locator('.pick', { has: live(f) }).nth(i).getByRole('button', { name: 'Add stop' }).click()
  const plus = f.page.locator('.preview .body span').filter({ hasText: /\+\d+ min/ })
  await plus.waitFor()
  return plus.textContent()
}
export async function confirm(f: F) {
  const n = (await read(f)).trip!.plan.length
  await f.page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await until(f, d => d.trip!.plan.length === n + 1 && settled(d.trip), 'the stop to be planned')
}
export async function removeStop(f: F, name: string) {
  const n = (await read(f)).trip!.plan.length
  await openSheet(f)
  await f.page.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
  await until(f, d => d.trip!.plan.length === n - 1 && settled(d.trip), 'the stop to be removed')
}

// Plays the replay until stop(trip) holds, then pauses it (it may also have ended by itself).
export async function replay(f: F, stop: (t: Trip) => unknown, what: string) {
  const play = f.page.getByRole('button', { name: 'Replay this drive' })
  if (await play.isVisible()) await play.click()
  await until(f, d => stop(d.trip!), what, 240_000)
  const halt = f.page.getByRole('button', { name: 'Stop replay' })
  if (await halt.isVisible()) await halt.click()
}

export async function whereNext(f: F, pick: Pick) {
  const n = (await read(f)).trip!.plan.length
  await openSheet(f)
  await pickPlace(f, 'Where next?', pick)
  await f.page.locator('form.next').getByRole('button', { name: 'Add', exact: true }).click()
  await until(f, d => d.trip!.plan.length === n + 1 && settled(d.trip), 'the new destination to be routed')
}

// With a GPS watch running, Chromium answers getCurrentPosition only after the next position change, so p is nudged.
export async function imHere(f: F, p: LatLng) {
  await openSheet(f)
  await f.page.getByRole('button', { name: /I'm here/ }).click()
  await gps(f, p, d => d.trip!.live, 'live GPS')
}

export async function endTrip(f: F) {
  await openSheet(f)
  await f.page.getByRole('button', { name: 'End trip', exact: true }).click()
  await f.page.getByRole('alertdialog').getByRole('button', { name: 'End trip', exact: true }).click()
  await until(f, d => !d.trip, 'the trip to end')
  await f.page.locator('input[aria-label="From"]').waitFor()
}

export async function reload(f: F) {
  await f.page.reload()
  await f.page.locator('.tripbar, input[aria-label="From"]').first().waitFor()
  await until(f, d => d.trip, 'the trip to come back')
}

// Profile screen: the notes it lists. Opened from the plan sheet or the landing screen; back returns to where it was.
export async function profile(f: F, del?: RegExp) {
  if (await sheetButton(f).isVisible()) await openSheet(f)
  await f.page.getByRole('button', { name: 'Profile', exact: true }).click()
  if (del) await f.page.getByRole('button', { name: del }).click()
  return f.page.locator('.rows .row .body').allTextContents()
}
export const back = (f: F) => f.page.getByRole('button', { name: 'Back', exact: true }).click()

// Fake GPS. watchPosition only fires on a change and the app drops fixes closer than 10 s together, so the position is
// nudged ~1 m every 3 s until the state shows the app took it.
export function gps(f: F, p: LatLng, done: (d: Doc) => unknown, what: string, ms = 60_000) {
  let last = 0, n = 0
  return until(f, async d => {
    if (Date.now() - last > 3000) {
      last = Date.now()
      await f.ctx.setGeolocation({ latitude: p.lat + (n++ % 2) * 1e-5, longitude: p.lng })
    }
    return done(d)
  }, what, ms)
}
