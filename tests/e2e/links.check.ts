// Offline check of lib.ts linkProblem on a saved bundle (no model, no browser): the hrefs are what the app renders,
// linksFor(trip, ref). Usage: node tests/e2e/links.check.ts <bundle>/F3/08.json leopold
// Expected on the 2026-10-10 12:26 bundle (make_link was Sassoon Dock Clock Tower): FAILS; and passes once the same
// message points at the place asked about.
import { readFileSync } from 'node:fs'
import { linksFor, type Trip } from '@trippy/core'
import { linkProblem } from './lib.ts'

const [file, name = 'leopold'] = process.argv.slice(2)
const t: Trip = JSON.parse(readFileSync(file, 'utf8')).trip
const want = new RegExp(name, 'i')
const check = (trip: Trip) => {
  const m = trip.messages.findLast(m => m.link)
  if (!m) return 'no link message'
  const l = linksFor(trip, m.link!)
  return linkProblem(trip, [m], want, [l.maps, l.uber, l.whatsapp])
}
const m = t.messages.findLast(m => m.link)
const right = Object.entries(t.places).find(([, p]) => want.test(p.name))?.[0]
const bad = check(t)
console.log(`as saved: link ${m?.link} = ${m && t.places[m.link!]?.name}\n  ${bad ? `FAILS: ${bad}` : 'passes'}`)
if (right && m) {
  const fixed = check({ ...t, messages: t.messages.map(x => x === m ? { ...x, link: right } : x) })
  console.log(`link pointed at ${right} (${t.places[right].name}):\n  ${fixed ? `FAILS: ${fixed}` : 'passes'}`)
}
