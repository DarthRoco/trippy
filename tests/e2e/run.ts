// E2E runner (spec: bus E2E.md). `npm run e2e` drives the flows in parallel, one browser context (= one proxy session) each,
// against the live site; `-- --local[=port]` targets http://localhost:<port> (default 5173; start the web app and `npm run dev:proxy`).
// Other flags: `--url=<site>`, `--chrome` (installed Chrome instead of Playwright's Chromium), `--headed`. Flow ids pick flows:
// `npm run e2e -- --local=5174 F1 F10`. With no ids it runs all ten.
// Output: test-results/e2e/<time>/summary.json and, per flow, a folder with each step's screen text, screenshot, trip document
// and the flow's debug log. Exit code 1 when any code check (C) failed; judge notes (J) are for the reviewer.
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, devices } from '@playwright/test'
import { FLOWS } from './flows.ts'
import type { Trip } from '@trippy/core'
import { ANNOUNCES, counts, events, istNow, planned, problems, RAW, read, skipped, sumCounts, type F, type Flow, type View } from './lib.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.find(a => a === `--${name}` || a.startsWith(`--${name}=`))?.split('=')[1] ?? (args.includes(`--${name}`) ? '1' : '')
const base = flag('url') || (flag('local') ? `http://localhost:${flag('local') === '1' ? 5173 : flag('local')}` : 'https://trippy-c20.pages.dev')
const ids = args.filter(a => /^F\d+$/.test(a))
const flows = ids.length ? FLOWS.filter(f => ids.includes(f.id)) : FLOWS
const dir = `test-results/e2e/${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`

type Result = { name: string; ok: boolean; detail?: unknown; skipped?: string }
const result = (name: string, v: unknown): Result =>
  v === true ? { name, ok: true } : skipped(v) ? { name, ok: true, skipped: v.skip } : { name, ok: false, detail: v }

// Searches this step added (a new trip counts from its first search).
const fresh = (v: View) => v.trip ? v.trip.searches.slice(v.before.trip?.id === v.trip.id ? v.before.trip.searches.length : 0) : []

// The checks every step gets (E2E.md): quiet console, clean replies, Latin names, distinct card titles, a fast answer.
const everyStep = (v: View): [string, unknown][] => {
  const replies = v.added.filter(m => m.role === 'assistant').map(m => m.text)
  const shown = [...replies, ...fresh(v).flatMap(s => [s.say, ...s.picks.map(p => p.reason)])]
  const twins = v.trip ? fresh(v).map(s => {
    const names = s.picks.map(p => v.trip!.places[p.ref].name)
    return { search: s.id, twins: [...new Set(names.filter((n, i) => names.indexOf(n) !== i))] }
  }).filter(s => s.twins.length) : []
  const twice = v.log.filter(e => e.type === 'answer').flatMap(e => {
    const s: string[] = (e.data.steps ?? []).map((x: any) => `${x.name} ${JSON.stringify(x.args)}`)
    return [...new Set(s.filter((x, i) => s.indexOf(x) !== i))]
  })
  const limit = planned(v.log) ? 30_000 : 12_000
  return [
    ['no console errors', !v.f.errors.length || v.f.errors],
    ['replies have no ref and do not announce work', replies.every(t => !/\bp\d+\b/.test(t) && !ANNOUNCES.test(t)) || replies],
    ['no raw field values in replies or cards', shown.every(t => !RAW.test(t)) || shown.filter(t => RAW.test(t))],
    // #64: the same tool with the same args twice in one answer is a wasted call.
    ['no tool called twice with the same args in one answer', !twice.length || twice],
    ['place names in Latin script', !v.trip || Object.values(v.trip.places).every(p => !/[؀-ۿऀ-෿฀-໿぀-ヿ一-鿿]/.test(p.name)) || Object.values(v.trip.places).map(p => p.name)],
    ['card titles distinct within a search', !twins.length || twins], // fails until B12 (a locality on duplicate names)
    [`answer within ${limit / 1000} s${limit > 12_000 ? ' (planning tier)' : ''}`, v.f.ms === undefined || v.f.ms <= limit || `${v.f.ms} ms`],
  ]
}

async function runFlow(flow: Flow, browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const out = `${dir}/${flow.id}`
  await mkdir(out, { recursive: true })
  const ctx = await browser.newContext({
    ...(flow.phone ? devices['Pixel 7'] : { viewport: { width: 412, height: 900 } }), locale: 'en-IN',
    ...(flow.geo && { geolocation: { latitude: flow.geo.lat, longitude: flow.geo.lng }, permissions: ['geolocation'] }),
  })
  // Chromium's emulated GPS answers getCurrentPosition with error 2 while a watchPosition runs, and the app always has one
  // (diagnosed on F10 step 6, "I'm here"). A real phone does not do this. The shim answers from a one-shot watch, which
  // first reports that same error and then the position, so it ignores errors and waits for the position.
  await ctx.addInitScript(() => {
    const g = navigator.geolocation
    g.getCurrentPosition = (ok, _err, o) => { const id = g.watchPosition(p => { g.clearWatch(id); ok(p) }, () => {}, o) }
  })
  const page = await ctx.newPage()
  const f: F = { page, ctx, base, errors: [] }
  page.on('console', m => m.type() === 'error' && f.errors.push(m.text()))
  page.on('pageerror', e => f.errors.push(String(e)))

  // A second trip legitimately restarts at p1, so refs are tracked per trip id, and so is the v2 validity check.
  const seen: Record<string, Record<string, string | null>> = {}, reused: Record<string, Set<string>> = {}
  const bad = (t: Trip) => [...new Set([...problems(t, seen[t.id] ??= {}), ...(reused[t.id] ?? [])])]
  const valid = (t: Trip) => { const b = bad(t); return result(`trip ${t.id} document is valid v2`, !b.length || b) }
  const ended: Result[] = []
  let last: Trip | null = null // the last trip document seen: a trip that ended is checked as it was before End trip
  const steps: unknown[] = []
  const t00 = Date.now()
  let before = { trip: null, profile: [] } as Awaited<ReturnType<typeof read>>, failed = ''
  for (const [i, s] of flow.steps.entries()) {
    const n = String(i + 1).padStart(2, '0')
    if (failed) { steps.push({ n: i + 1, say: s.say, skipped: `after "${failed}"` }); continue }
    const t0 = Date.now()
    f.errors = []
    f.ms = undefined
    const c: Result[] = []
    let o: unknown, v: View | undefined
    try { o = await s.run(f, before) } catch (e) { c.push(result('step ran', String(e).split('\n')[0])); failed = s.say }
    const ms = Date.now() - t0
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    await page.screenshot({ path: `${out}/${n}.png` }).catch(() => {})
    const now = await read(f).catch(() => before)
    const log = (await events(f).catch(() => [])).filter(e => e.t >= t0)
    await writeFile(`${out}/${n}.txt`, text)
    await writeFile(`${out}/${n}.json`, JSON.stringify(now, null, 1))
    if (!failed) {
      v = { ...now, f, before, log, text, out: o, added: now.trip ? now.trip.messages.slice(before.trip?.id === now.trip.id ? before.trip.messages.length : 0) : [] }
      for (const [name, ok] of [...everyStep(v), ...(s.c ?? []).map(([name, fn]) => [name, fn] as const)]) {
        try { c.push(result(name, typeof ok === 'function' ? await ok(v) : ok)) } catch (e) { c.push(result(name, `check threw: ${e}`)) }
      }
      if (now.trip) problems(now.trip, seen[now.trip.id] ??= {}).filter(p => /reused/.test(p)).forEach(p => (reused[now.trip!.id] ??= new Set()).add(p))
    }
    if (last && now.trip?.id !== last.id) ended.push(valid(last))
    last = now.trip
    steps.push({ n: i + 1, say: s.say, ms, ...(f.ms !== undefined && { answer_ms: f.ms }), calls: counts(log), c, ...(s.j && { j: s.j }), files: `${flow.id}/${n}.*` })
    console.log(`${flow.id} ${n} ${c.every(r => r.ok) ? 'ok  ' : 'FAIL'} ${(ms / 1000).toFixed(1).padStart(5)} s  ${s.say}`)
    c.filter(r => r.skipped).forEach(r => console.log(`      ~ ${r.name}: skipped, ${r.skipped}`))
    c.filter(r => !r.ok).forEach(r => console.log(`      x ${r.name}: ${JSON.stringify(r.detail)?.slice(0, 300)}`))
    before = now
  }

  // The v2 document rules hold for every trip of the flow (E2E.md "At the end of every flow"): a trip that ended is
  // checked as it stood before End trip, the current one as it is now.
  const final = await read(f).catch(() => before)
  if (final.trip) last = final.trip
  const end = [...ended, ...(last ? [valid(last)] : [])]
  const log = await events(f).catch(() => [])
  await writeFile(`${out}/debug-log.json`, JSON.stringify(log.map(e => ({ ...e, t: new Date(e.t).toISOString() })), null, 1))
  let tokens = 0
  for (const e of log) if (e.type === 'call') tokens += e.data.response?.usage?.total_tokens ?? 0
  await ctx.close()
  const ok = !failed && end.every(r => r.ok) && steps.every((s: any) => s.skipped || s.c.every((r: Result) => r.ok))
  console.log(`${flow.id} ${ok ? 'PASSED' : 'FAILED'} in ${((Date.now() - t00) / 1000).toFixed(0)} s`)
  end.filter(r => !r.ok).forEach(r => console.log(`      x ${r.name}: ${JSON.stringify(r.detail)?.slice(0, 300)}`))
  return { id: flow.id, title: flow.title, ok, ms: Date.now() - t00, calls: counts(log), llm_tokens: tokens, steps, end }
}

const started = new Date()
console.log(`E2E ${flows.map(f => f.id).join(' ')} against ${base} -> ${dir}  (${istNow(+started)})`)
const browser = await chromium.launch({ headless: !flag('headed'), channel: flag('chrome') ? 'chrome' : undefined })
const done = await Promise.all(flows.map(f => runFlow(f, browser).catch(e => ({ id: f.id, title: f.title, ok: false, error: String(e) }))))
await browser.close()
// The IST time comes first: "now" is in the model's context and open-now answers follow the clock.
await writeFile(`${dir}/summary.json`, JSON.stringify({
  run: { ist: istNow(+started), utc: started.toISOString() }, target: base,
  calls: sumCounts(done.flatMap(f => 'calls' in f ? [f.calls] : [])), flows: done,
}, null, 1))
console.log(`${done.filter(f => f.ok).length}/${done.length} flows passed. ${dir}/summary.json`)
process.exit(done.every(f => f.ok) ? 0 : 1)
