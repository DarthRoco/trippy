// Run: node packages/core/src/planner/hours.check.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { closingTime, isOpen, parseWeekday, periodsToIntervals, windows, type Period } from './hours.ts'

const SUN = 0, SAT = 6
const day = periodsToIntervals([{ open: { day: 0, hour: 10 }, close: { day: 0, hour: 22 } }])
assert.equal(isOpen(day, SUN, 14 * 60, 15 * 60), true)
assert.equal(isOpen(day, SUN, 21 * 60, 23 * 60), false) // runs past closing
assert.equal(isOpen(null, SUN, 0, 60), null) // hours unknown

// Open past midnight: Sunday 18:00 to Monday 01:00 covers a visit ending 00:30.
const late = periodsToIntervals([{ open: { day: 0, hour: 18 }, close: { day: 1, hour: 1 } }])
assert.equal(isOpen(late, SUN, 23 * 60, 24 * 60 + 30), true)
// Saturday night into Sunday wraps the week.
const wrap = periodsToIntervals([{ open: { day: 6, hour: 20 }, close: { day: 0, hour: 2 } }])
assert.equal(isOpen(wrap, SUN, 30, 90), true)
assert.equal(isOpen(wrap, SUN, 90, 150), false)

assert.deepEqual(periodsToIntervals([{ open: { day: 0, hour: 0 } }]), [[0, 10080]]) // no close = 24/7
assert.equal(periodsToIntervals([]), null)
assert.equal(periodsToIntervals(undefined), null)

// A park open twice a day: the gap is closed.
const park = periodsToIntervals([
  { open: { day: 6, hour: 6 }, close: { day: 6, hour: 10 } },
  { open: { day: 6, hour: 16 }, close: { day: 6, hour: 21 } },
])
assert.deepEqual(windows(park, SAT), [[360, 600], [960, 1260]])
assert.deepEqual(windows(park, SUN), [])
assert.equal(closingTime(park, SAT, 8 * 60), 10 * 60)
assert.equal(closingTime(park, SAT, 12 * 60), null)
assert.equal(closingTime(null, SAT, 8 * 60), null)

assert.equal(parseWeekday('Sunday', 3), 0)
assert.equal(parseWeekday(' saturday ', 3), 6)
assert.equal(parseWeekday('today', 3), 3)

// Same answers as the Python planner on real Google opening hours.
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8')) as { hours: { periods: Period[]; intervals: [number, number][] }[] }
assert.ok(golden.hours.length > 20)
for (const h of golden.hours) assert.deepEqual(periodsToIntervals(h.periods), h.intervals)
console.log('planner hours ok')
