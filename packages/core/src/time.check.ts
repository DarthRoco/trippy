// Run: node packages/core/src/time.check.ts
import assert from 'node:assert/strict'
import { deadlineNote, deadlineOf, deadlineTimes, departTime, noteDeadline } from './time.ts'

const at = (ist: string) => new Date(ist + '+05:30') // a moment, given as IST wall clock
const noon = at('2026-10-03T12:00:00')

assert.equal(departTime('We leave at 7 pm for Trishna, is that a bad idea?', noon), '2026-10-03T19:00:00+05:30')
assert.equal(departTime('leaving at 7:30', noon), '2026-10-03T19:30:00+05:30') // no am/pm -> next 7:30
assert.equal(departTime('7 baje nikalenge', noon), '2026-10-03T19:00:00+05:30')
assert.equal(departTime('we leave at 9 am', noon), '2026-10-04T09:00:00+05:30') // passed today -> tomorrow
assert.equal(departTime('leave at 11 pm', at('2026-10-03T23:30:00')), '2026-10-04T23:00:00+05:30')
assert.equal(departTime('we leave at 7 pm tomorrow', noon), '2026-10-04T19:00:00+05:30') // not today's 19:00
assert.equal(departTime('leaving tomorrow at 1 pm', noon), '2026-10-04T13:00:00+05:30') // 1 pm is still ahead today, tomorrow wins
assert.equal(departTime('kal subah 7 baje nikalenge', noon), '2026-10-04T07:00:00+05:30')
assert.equal(departTime('Airport by 6, want to eat on the way'), null) // a deadline, not a departure
assert.equal(departTime('veg place within 10 min'), null)
assert.equal(departTime('leave at 25:00', noon), null)
// deadlineTimes (#62): explicit am / pm is one moment (the next such time); a bare hour is both; leaving is not a deadline.
const ms = (ist: string) => at(ist).getTime()
const evening = at('2026-10-10T17:56:00')
assert.deepEqual(deadlineTimes('our flight is at 6 am, will we make it?', evening), [ms('2026-10-11T06:00:00')])
assert.deepEqual(deadlineTimes('our flight is at 6, will we make it?', at('2026-10-10T00:55:00')), [ms('2026-10-10T06:00:00'), ms('2026-10-10T18:00:00')])
assert.deepEqual(deadlineTimes('Airport by 6, want to eat on the way, 30 min max stop', evening), [ms('2026-10-10T18:00:00'), ms('2026-10-11T06:00:00')])
assert.deepEqual(deadlineTimes('train at 5:30 pm tomorrow', evening), [ms('2026-10-11T17:30:00')])
assert.deepEqual(deadlineTimes('we have to reach by 9 pm', evening), [ms('2026-10-10T21:00:00')])
assert.deepEqual(deadlineTimes('we leave at 7 pm, flight at 11', evening), []) // leaving: departTime's job
assert.deepEqual(deadlineTimes('veg place within 10 min', evening), [])
assert.deepEqual(deadlineTimes('a dhaba by the highway at 8 pm', evening), []) // "by" needs a number after it
// Ride 2026-10-18: a time alone after a flight question is the flight's deadline, with the airport named; a flight carries the
// 90 min buffer and goes to an airport; "airport by 6" has no buffer; a reach-by is a plain deadline. Notes keep one moment.
const ride = at('2026-10-18T13:16:00')
assert.deepEqual(deadlineTimes('4pm from navi mumbai', ride), [])
const nm = deadlineOf('4pm from navi mumbai', ride, 'Will we still make it for the flight No flight details yet')!
assert.deepEqual(nm, { times: [ms('2026-10-18T16:00:00')], what: 'flight', hub: 'airport', buffer: 90, at: 'navi mumbai' })
assert.deepEqual(deadlineOf('I have a flight to catch at 3PM will I make it?', at('2026-10-18T11:22:00')),
  { times: [ms('2026-10-18T15:00:00')], what: 'flight', hub: 'airport', buffer: 90 })
assert.equal(deadlineOf('flight from Navi Mumbai airport at 4pm', ride)!.at, 'Navi Mumbai')
assert.equal(deadlineOf('train from CSMT at 5:30 pm', ride)!.buffer, 20)
assert.deepEqual([deadlineOf('Airport by 6, want to eat', evening)!.buffer, deadlineOf('Airport by 6, want to eat', evening)!.hub], [0, 'airport'])
assert.equal(deadlineOf('we have to reach by 9 pm', evening)!.hub, undefined)
assert.equal(deadlineOf('4pm', ride, 'find chai'), null) // no flight before: not a deadline
assert.equal(deadlineNote(nm), 'Deadline: flight 2026-10-18 16:00 IST from navi mumbai')
assert.deepEqual(noteDeadline(deadlineNote(nm)), nm)
assert.equal(noteDeadline('Dad is diabetic'), null)
console.log('time ok')
