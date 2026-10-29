// Run: node packages/core/src/planner/sun.check.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { nextDate, sunsetMinutes } from './sun.ts'

// Same sunsets as the Python planner (the astral library), for six Indian cities across the year. astral models
// refraction slightly differently, so a minute or two of difference is allowed.
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8')) as { sunsets: { city: string; lat: number; lng: number; date: string; sunset_min: number }[] }
assert.equal(golden.sunsets.length, 30)
for (const s of golden.sunsets) {
  const [year, month, day] = s.date.split('-').map(Number)
  const got = sunsetMinutes({ lat: s.lat, lng: s.lng }, { year, month, day })
  assert.ok(Number.isInteger(got))
  assert.ok(Math.abs(got - s.sunset_min) <= 2, `${s.city} ${s.date}: ${got}, Python said ${s.sunset_min}`)
}

// Sanity outside the fixture: Bengaluru sets later in June than in December, and Kolkata (east) before Mumbai (west).
const blr = { lat: 12.97, lng: 77.59 }
assert.ok(sunsetMinutes(blr, { year: 2027, month: 6, day: 21 }) > sunsetMinutes(blr, { year: 2027, month: 12, day: 21 }))
assert.ok(sunsetMinutes({ lat: 22.57, lng: 88.36 }, { year: 2027, month: 3, day: 1 }) < sunsetMinutes({ lat: 19.08, lng: 72.88 }, { year: 2027, month: 3, day: 1 }))

// nextDate: 2026-10-11 is a Sunday.
const at = (ist: string) => new Date(ist + '+05:30') // a moment, given as IST wall clock
const sunday = at('2026-10-11T12:00:00')
assert.deepEqual(nextDate(0, sunday), { year: 2026, month: 10, day: 11 }) // today counts
assert.deepEqual(nextDate(1, sunday), { year: 2026, month: 10, day: 12 })
assert.deepEqual(nextDate(6, sunday), { year: 2026, month: 10, day: 17 })
assert.deepEqual(nextDate(1, at('2026-10-29T09:00:00')), { year: 2026, month: 11, day: 2 }) // Thursday -> Monday, into the next month
assert.deepEqual(nextDate(3, at('2026-12-31T23:00:00')), { year: 2027, month: 1, day: 6 }) // Thursday -> Wednesday, into the next year
// The date is the IST one: 20:00 UTC on Saturday is already Sunday 01:30 in India.
assert.deepEqual(nextDate(0, new Date('2026-10-10T20:00:00Z')), { year: 2026, month: 10, day: 11 })
assert.deepEqual(nextDate(6, new Date('2026-10-10T20:00:00Z')), { year: 2026, month: 10, day: 17 })
console.log('planner sun ok')
