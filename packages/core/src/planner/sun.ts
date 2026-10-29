// Sunset for a point in India, and the date an outing falls on. The NOAA solar equations in plain code, no library.
import type { LatLng } from '../types.ts'

type Day = { year: number; month: number; day: number } // month 1 to 12
const IST_MIN = 330
const RAD = Math.PI / 180
const ZENITH = 90.833 // the sun's upper edge on the horizon, refraction included
const sin = (deg: number) => Math.sin(deg * RAD), cos = (deg: number) => Math.cos(deg * RAD), tan = (deg: number) => Math.tan(deg * RAD)

// Sunset in minutes after 00:00 UTC, with the sun where it is at Julian century t.
function sunsetUtc(at: LatLng, t: number): number {
  const l0 = 280.46646 + t * (36000.76983 + t * 0.0003032) // mean longitude
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t) // mean anomaly
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t) // eccentricity of the orbit
  const centre = sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sin(2 * m) * (0.019993 - 0.000101 * t) + sin(3 * m) * 0.000289
  const omega = 125.04 - 1934.136 * t
  const lambda = l0 + centre - 0.00569 - 0.00478 * sin(omega) // apparent longitude
  const tilt = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * cos(omega)
  const decl = Math.asin(sin(tilt) * sin(lambda)) / RAD
  const y = tan(tilt / 2) ** 2
  // equation of time: minutes the sun runs ahead of the clock
  const eot = (4 / RAD) * (y * sin(2 * l0) - 2 * e * sin(m) + 4 * e * y * sin(m) * cos(2 * l0) - 0.5 * y * y * sin(4 * l0) - 1.25 * e * e * sin(2 * m))
  // hour angle at sunset. Always defined in India (no polar day or night).
  const ha = Math.acos(cos(ZENITH) / (cos(at.lat) * cos(decl)) - tan(at.lat) * tan(decl)) / RAD
  return 720 - 4 * at.lng - eot + 4 * ha
}

// Local sunset as minutes since midnight IST, on an IST calendar date.
export function sunsetMinutes(at: LatLng, date: Day): number {
  const jd = Date.UTC(date.year, date.month - 1, date.day) / 86_400_000 + 2440587.5 // Julian day at 00:00 UTC
  const century = (utcMin: number) => (jd + utcMin / 1440 - 2451545) / 36525
  // Two passes: the sun at noon gives a first sunset, the sun at that moment gives the answer.
  // floor: whole minutes with the seconds dropped, as the Python planner reported it
  return Math.floor(sunsetUtc(at, century(sunsetUtc(at, century(720)))) + IST_MIN)
}

// The IST date of the next occurrence of weekday (0 = Sunday), today included.
export function nextDate(weekday: number, now = new Date()): Day {
  const ist = new Date(now.getTime() + IST_MIN * 60_000) // IST wall clock in UTC fields
  const ahead = (((weekday - ist.getUTCDay()) % 7) + 7) % 7
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + ahead))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
