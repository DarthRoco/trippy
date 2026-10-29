import { complete, PLANNER_MODELS } from './model.ts'
import { MEAL_HOURS } from './search.ts'
import { STOP_TYPES } from './types.ts'
import type { Budget, Constraints, NamedPlace, StopType } from './types.ts'

// Accuracy was measured on the Python repo's text (RESULTS.md there). Shopping, named places and unsupported activities
// were added on 2026-10-24 (Shruti's Kopitiam Lah request), with the old wording kept; re-measure after any change.
export const SYSTEM_PROMPT = `You convert an outing request for Bangalore into JSON.
Return only a JSON object with these keys:
duration_minutes (int), start_time (HH:MM, 24-hour), day (string),
area (string), stops (ordered list using only: coffee, work, sunset, dinner,
lunch, snack, walk, bar, shopping), max_travel_minutes (int), budget (low, medium, high),
must_haves (list of strings), stay_minutes (object, optional), shop_for (string),
named_places (list of objects), unsupported (list of strings).
stops lists only what the user names, in the order they will do it ("before that" puts a stop earlier). Never add a stop they did not ask for. Words like chai, filter coffee, or cafe mean coffee. Lunch, brunch, and a meal mean lunch or dinner.
Buying or browsing for anything, such as a ring, clothes, a gift, or books, means shopping. shop_for is the user's own words for what they want to buy, such as "demi fine or semi precious statement ring", or "" if they do not say.
named_places lists each place the user names by its own name, such as Toit in "dinner at Toit at 8pm". The name never includes its time. A kind of place, such as "a cafe in Jayanagar", is not a named place. Usually it is []. Each is {"name": the name copied verbatim from the request, "stop": the stop type it is (if the user does not say, use the time: lunch from 11:30 to 15:30, dinner from 18:00, else the type that fits the place), "time": its time as HH:MM if the user gives one, else ""}.
A named place is one of the stops, in its place in the order. Never add another stop because of a word in its name.
A time the user gives for a named place is that place's time, not start_time.
unsupported lists each activity the user asks for that matches none of the stop types, as a short noun such as "a movie" or "bowling". It is for activities only, never for things to buy. Never turn it into another stop type.
stay_minutes maps a stop type to the minutes the user says they want there, such as {"work": 60}. Fill it only when the user says how long to stay at a stop, such as "work for an hour".
Never split the total duration across stops. For most requests it is {}.
duration_quote (string) is the exact words of the request that state the total outing length, or "".
stay_quotes (object) maps each stop type in stay_minutes to the exact words of the request that state the length, copied verbatim.
stated_quotes (object) maps each of start_time, duration_minutes, day, max_travel_minutes, budget to the exact words of the request
that state it, copied verbatim. Leave a key out when the request does not state it.
If nothing the user asks for matches a stop type, return stops as [].
must_haves holds every quality or audience the user asks for, such as "quiet", "outdoor seating",
"easy parking", "romantic", or "kid-friendly" (for "with the kids" or "for my parents", add the audience). Never repeat stop types or what to buy there.
area is one neighbourhood. If the user names two, use the first.
max_travel_minutes: use the number the user gives, in any language.
start_time is when the outing starts. For "afternoon" use "14:00", for "evening" use "18:00", for "morning" use "09:00".
If the request omits a value, use a sensible default: budget "medium",
max_travel_minutes 30, day "today", start_time "16:00".
Do not compute distances or times. Only read what the request says.`

export class ParseError extends Error {}
// The model read the request fine and found no stop the planner supports ("bowling and a movie"). Not retried: at
// temperature 0 the same request gets the same answer, so a retry only doubled the wait.
export class Unsupported extends ParseError {}

const STATED_FIELDS = ['start_time', 'duration_minutes', 'day', 'max_travel_minutes', 'budget']
// "dinner in Koramangala" names no place: nothing is left once stop types, generic words and the area are taken out.
const GENERIC = new Set<string>([...STOP_TYPES, 'a', 'an', 'the', 'in', 'at', 'near', 'some', 'place', 'spot', 'cafe', 'restaurant', 'shop', 'store', 'mall', 'park'])
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const namesAPlace = (name: string, area: string) => words(name).some(w => !GENERIC.has(w) && !words(area).includes(w))
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
// Words that say a stop's type. A named place whose type the user never said takes it from its time, as the prompt
// asks: the model once made Kopitiam Lah at 7pm a coffee stop (kopitiam is Malay for coffee shop).
const STOP_WORDS: Record<StopType, string[]> = { coffee: ['coffee', 'cafe', 'café', 'chai', 'tea'], work: ['work'], sunset: ['sunset'],
  dinner: ['dinner', 'supper'], lunch: ['lunch', 'brunch'], snack: ['snack', 'dessert', 'ice cream'], walk: ['walk', 'stroll'],
  bar: ['bar', 'drink', 'pub', 'beer', 'cocktail'], shopping: ['shop', 'buy'] }
const mealAt = (hhmm: string) => {
  const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
  return (Object.entries(MEAL_HOURS) as [StopType, [number, number]][]).find(([, [a, b]]) => a <= m && m <= b)?.[0]
}
// "Kopitiam Lah at 7:30pm" -> "Kopitiam Lah": the model copied the time into the name.
const TIME_TAIL = /\s+(?:at|by|around|@)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*$/i
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A "place" named by an activity we cannot plan is that activity, not a stop (R6b #109: "Spa" became a work stop).
const ACTIVITY = new Set(['spa', 'movie', 'movies', 'cinema', 'cinemas', 'film', 'bowling', 'gym', 'salon', 'massage', 'concert', 'show', 'game', 'play'])

// Check the model's claims against the request text. A field counts as stated only if the model quoted words that
// appear in the request, so a default is never reported as stated. A stay length is kept only if its quote is in the
// request and is not the total-duration phrase.
export function grounded(data: Record<string, any>, text: string): Record<string, any> {
  const low = text.toLowerCase()
  const q = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '')
  const said = new Set(Object.entries(isObj(data.stated_quotes) ? data.stated_quotes : {}).filter(([, v]) => q(v) && low.includes(q(v))).map(([k]) => k))
  const total = q(data.duration_quote)
  const quotes = isObj(data.stay_quotes) ? data.stay_quotes : {}
  const stated = (quote: unknown) => !!q(quote) && low.includes(q(quote)) && !(total && (total.includes(q(quote)) || q(quote).includes(total)))
  const { stated_quotes, duration_quote, stay_quotes, ...rest } = data
  const stops: unknown[] | undefined = Array.isArray(data.stops) ? [...data.stops] : undefined
  const saidType = (t: unknown) => (STOP_WORDS[t as StopType] ?? []).some(w => new RegExp(`(^|[^a-z])${w}`).test(low))
  const activities: string[] = []
  const named = !Array.isArray(data.named_places) ? undefined : data.named_places.flatMap((n: any) => {
    if (!isObj(n) || typeof n.name !== 'string') return []
    const name = n.name.replace(TIME_TAIL, '').trim()
    // a name the model did not copy from the request is not the user's: never look up a place they did not name
    if (!name || !low.includes(name.toLowerCase())) return []
    if (words(name).some(w => ACTIVITY.has(w))) {
      activities.push(name)
      const i = stops?.indexOf(n.stop) ?? -1
      if (i >= 0 && !saidType(n.stop)) stops!.splice(i, 1) // the stop the model made up for it
      return []
    }
    const meal = typeof n.time === 'string' && /^\d{2}:\d{2}$/.test(n.time) ? mealAt(n.time) : undefined
    if (!meal || meal === n.stop || saidType(n.stop)) return [{ ...n, name }]
    const i = stops?.indexOf(n.stop) ?? -1
    if (i >= 0 && !stops!.includes(meal)) stops![i] = meal // the stop it was is this meal
    return [{ ...n, name, stop: meal }]
  })
  // A thing to buy is never an activity we cannot plan: shopping plans it.
  const toBuy = (u: string) => q(data.shop_for).includes(u.toLowerCase())
    || new RegExp(String.raw`\b(?:buy|by|get|purchase|shop(?:ping)? for)(?:\s+(?!(?:and|then|or)\b)\w+){0,4}?\s+` + escape(u.toLowerCase())).test(low)
  return {
    ...rest,
    ...(stops && { stops }),
    ...(named && { named_places: named }),
    unsupported: [...(Array.isArray(data.unsupported) ? data.unsupported : [])
      .filter((u: unknown) => !stops?.includes('shopping') || typeof u !== 'string' || !toBuy(u)), ...activities],
    assumed: STATED_FIELDS.filter(f => !said.has(f)),
    stay_minutes: Object.fromEntries(Object.entries(isObj(data.stay_minutes) ? data.stay_minutes : {}).filter(([k]) => stated(quotes[k]))),
  }
}

// What Pydantic checked in the Python version. Throws on anything invalid; unknown keys are ignored.
function validate(d: Record<string, any>): Constraints {
  const int = (v: unknown, min: number, name: string) => {
    if (!Number.isInteger(v) || (v as number) < min) throw new Error(`${name} must be an integer >= ${min}`)
    return v as number
  }
  const str = (v: unknown, name: string) => {
    if (typeof v !== 'string') throw new Error(`${name} must be a string`)
    return v
  }
  if (!/^\d{2}:\d{2}$/.test(str(d.start_time, 'start_time'))) throw new Error('start_time must be HH:MM')
  if (!Array.isArray(d.stops) || !d.stops.length || d.stops.some(s => !(STOP_TYPES as readonly string[]).includes(s))) throw new Error('stops must be a non-empty list of stop types')
  const budget = d.budget === undefined ? 'medium' : d.budget
  if (!['low', 'medium', 'high'].includes(budget)) throw new Error('budget must be low, medium or high')
  const stay = d.stay_minutes ?? {}
  if (!isObj(stay) || Object.values(stay).some(v => !Number.isInteger(v))) throw new Error('stay_minutes must map stop types to integers')
  const must = d.must_haves === undefined ? [] : d.must_haves
  if (!Array.isArray(must) || must.some(m => typeof m !== 'string')) throw new Error('must_haves must be a list of strings')
  if (!Array.isArray(d.assumed)) throw new Error('assumed must be a list')
  const list = (v: unknown) => (Array.isArray(v) ? v : [])
  const stops = [...d.stops] as StopType[]
  // A named place needs a known stop type; one whose type the model left out of stops joins at the end.
  const named: NamedPlace[] = []
  for (const n of list(d.named_places)) {
    if (!isObj(n) || typeof n.name !== 'string' || !namesAPlace(n.name, d.area) || !(STOP_TYPES as readonly string[]).includes(n.stop)) continue
    if (named.some(x => x.stop === n.stop)) continue // one per stop type
    named.push({ name: n.name.trim(), stop: n.stop, time: typeof n.time === 'string' && /^\d{2}:\d{2}$/.test(n.time) ? n.time : '' })
    if (!stops.includes(n.stop)) stops.push(n.stop)
  }
  return {
    duration_minutes: int(d.duration_minutes, 1, 'duration_minutes'),
    start_time: d.start_time,
    day: str(d.day, 'day'),
    area: str(d.area, 'area'),
    stops,
    max_travel_minutes: int(d.max_travel_minutes, 0, 'max_travel_minutes'),
    budget: budget as Budget,
    stay_minutes: stay as Constraints['stay_minutes'],
    assumed: d.assumed,
    must_haves: must,
    shop_for: typeof d.shop_for === 'string' ? d.shop_for.trim() : '',
    named_places: named,
    // once each, whatever the case ("spa" listed and "Spa" named)
    unsupported: [...new Map(list(d.unsupported).filter((u): u is string => typeof u === 'string' && !!u.trim()).map(u => [u.trim().toLowerCase(), u.trim()])).values()],
  }
}

// Parse a request. Retry once on invalid output, then throw ParseError. No supported stop: Unsupported at once.
export async function parseRequest(text: string): Promise<Constraints> {
  let last = ''
  for (let i = 0; i < 2; i++) {
    const raw = await complete(PLANNER_MODELS.parse, SYSTEM_PROMPT, text, { json: true })
    let data: unknown
    try { data = JSON.parse(raw) } catch (e) { last = String(e); continue }
    if (isObj(data) && Array.isArray(data.stops)) {
      // A stop type we do not have ("movie") is an activity we cannot plan: said, not retried.
      const known = (s: unknown) => (STOP_TYPES as readonly unknown[]).includes(s)
      const listed: unknown[] = Array.isArray(data.unsupported) ? data.unsupported : []
      const said = (s: string) => listed.some(u => typeof u === 'string' && u.toLowerCase().includes(s.toLowerCase())) // "watch a movie" has it
      data.unsupported = [...listed, ...data.stops.filter(s => typeof s === 'string' && !known(s) && !said(s))]
      data.stops = data.stops.filter(known)
    }
    const g = isObj(data) ? grounded(data, text) : data // grounded may drop a stop made up for an activity ("Spa")
    if (isObj(g) && Array.isArray(g.stops) && !g.stops.length) throw new Unsupported('No supported stop in the request')
    try {
      if (!isObj(g)) throw new Error('not a JSON object')
      return validate(g)
    } catch (e) {
      last = String(e)
    }
  }
  throw new ParseError(`Could not parse the request after 2 tries: ${last}`)
}
