// Run: node packages/core/src/geo.check.ts
import assert from 'node:assert/strict'
import { decode, encode, cut, km, along } from './geo.ts'

// Google's documented example polyline.
const ex = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'
assert.deepEqual(decode(ex), [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }])
assert.equal(encode(decode(ex)), ex)

// cut keeps the start, ends partway, and its length matches the fraction.
const len = (p: string) => {
  const q = decode(p)
  return q.slice(1).reduce((s, x, i) => s + km(q[i], x), 0)
}
const half = cut(ex, 0.5)
assert.deepEqual(decode(half)[0], decode(ex)[0])
assert.ok(Math.abs(len(half) / len(ex) - 0.5) < 0.01, `half length ratio ${len(half) / len(ex)}`)
assert.equal(cut(ex, 1.2), ex)
assert.ok(decode(cut(ex, 0)).length >= 2)

// along: a point a third of the way along, 50 m off the line, cuts the route there.
const line = encode([{ lat: 19, lng: 72.8 }, { lat: 19, lng: 72.9 }, { lat: 19.1, lng: 72.9 }]) // ~10.5 km east, then ~11.1 km north
const near = { lat: 19.00045, lng: 72.85 } // 50 m north of the first leg's middle
const on = along(line, near)
assert.ok(Math.abs(on.offKm - 0.05) < 0.005, `off ${on.offKm}`)
assert.ok(Math.abs(on.doneKm - on.totalKm * 0.2427) < 0.1, `done ${on.doneKm} of ${on.totalKm}`)
assert.ok(Math.abs(len(on.rest) - (on.totalKm - on.doneKm)) < 0.05)
console.log('geo ok')
