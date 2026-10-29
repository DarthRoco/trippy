// Opening-hours logic. Plain code, no model. Times are minutes; a week is 10080.
import type { Interval } from './types.ts'

const DAY = 1440, WEEK = 7 * DAY
export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

type Point = { day: number; hour?: number; minute?: number }
export type Period = { open: Point; close?: Point }

// Google regularOpeningHours.periods -> weekly intervals. A period with no close means open 24/7.
export function periodsToIntervals(periods?: Period[] | null): Interval[] | null {
  if (!periods?.length) return null
  const out: Interval[] = []
  const at = (p: Point) => p.day * DAY + (p.hour ?? 0) * 60 + (p.minute ?? 0)
  for (const p of periods) {
    if (!p.close) return [[0, WEEK]]
    const start = at(p.open)
    let end = at(p.close)
    if (end <= start) end += WEEK
    out.push([start, end])
  }
  return out
}

// true if the visit fits inside one open interval, null if hours are unknown.
// startMin / endMin are minutes since midnight on `weekday` (0 = Sunday); endMin may pass 1440.
export function isOpen(intervals: Interval[] | null, weekday: number, startMin: number, endMin: number): boolean | null {
  if (!intervals) return null
  const start = weekday * DAY + startMin, end = weekday * DAY + endMin
  // shift by a week: an interval that began last Saturday night may still cover Sunday morning
  return intervals.some(([lo, hi]) => [0, WEEK].some(s => lo <= start + s && end + s <= hi))
}

// 'Sunday' -> 0; anything else ('today') -> todayWeekday.
export function parseWeekday(day: string, todayWeekday: number): number {
  const i = DAYS.indexOf(day.trim().toLowerCase())
  return i >= 0 ? i : todayWeekday
}

// Open windows on one weekday as [open, close] minutes since midnight, clipped to that day.
export function windows(intervals: Interval[] | null, weekday: number): Interval[] {
  const day = weekday * DAY
  return (intervals ?? [])
    .filter(([lo, hi]) => lo < day + DAY && hi > day)
    .map(([lo, hi]): Interval => [Math.max(lo, day) - day, Math.min(hi, day + DAY) - day])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
}

// When the open window containing `minute` ends, or null if unknown or closed then.
export function closingTime(intervals: Interval[] | null, weekday: number, minute: number): number | null {
  return windows(intervals, weekday).find(([lo, hi]) => lo <= minute && minute < hi)?.[1] ?? null
}
