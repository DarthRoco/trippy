// "We leave at 7 pm" / "7 baje nikalenge" -> next such time in IST as ISO 8601 (+05:30), or null. "tomorrow" / "kal" -> tomorrow's.
// Used by the agent's code guard: a named departure time always gets a real eta_from_here (TESTSET #24).
const LEAVING = /\b(leave|leaving|depart\w*|start\w*|head(ing)? out|nikal\w*|chal\w*)\b/i
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje)\b|\b(\d{1,2}):(\d{2})\b/i
const TOMORROW = /\b(tomorrow|kal)\b/i
const IST = 330 * 60_000

export function departTime(text: string, now = new Date()): string | null {
  const m = LEAVING.test(text) && text.match(TIME)
  if (!m) return null
  const h = Number(m[1] ?? m[4]), min = Number(m[2] ?? m[5] ?? 0), ampm = m[3]?.toLowerCase()
  if (h > 23 || min > 59) return null
  // am/pm given -> that hour; otherwise ("7 baje", "7:30") the next of 7:00 / 19:00.
  const hours = ampm === 'pm' ? [h % 12 + 12] : ampm === 'am' ? [h % 12] : h < 12 ? [h, h + 12] : [h]
  const ist = new Date(now.getTime() + IST) // IST wall clock in UTC fields
  for (const day of TOMORROW.test(text) ? [1] : [0, 1]) for (const hh of hours) {
    const t = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + day, hh, min) - IST
    if (t > now.getTime()) return iso(new Date(t + IST))
  }
  return null
}

// "our flight is at 6 am" / "airport by 6" / "train 5:30 pm" -> the moments that time can mean: the next occurrence in IST (am / pm
// respected, "tomorrow" / "kal" -> tomorrow's). A bare hour is both its am and its pm. [] when no time is named, or the text is
// about leaving (departTime). TESTSET #62: "flight at 6 am" at 17:56 is tomorrow's, not "7:02 am".
const CUE = /\b(flight|train|bus|boarding|check-?in|reach|reaching|arrive|arriving|appointment|meeting|exam)\b|\b(by|before)\s+\d/i
const BARE = /\b(?:at|by|before)\s+(\d{1,2})\b(?!\s*(?:min|minute|hour|hr|km|rs))/i
// prior = the last messages: a time alone right after a flight or train question is its deadline ("4pm from navi mumbai", ride 2026-10-18).
export function deadlineTimes(text: string, now = new Date(), prior = ''): number[] {
  if (LEAVING.test(text) || !(CUE.test(text) || (/\b(flight|train)\b/i.test(prior) && TIME.test(text)))) return []
  const t = text.match(TIME), b = t ? null : text.match(BARE)
  if (!t && !b) return []
  const h = Number(t ? t[1] ?? t[4] : b![1]), min = t ? Number(t[2] ?? t[5] ?? 0) : 0, ampm = t?.[3]?.toLowerCase()
  if (h > 23 || min > 59) return []
  const hours = ampm === 'pm' ? [h % 12 + 12] : ampm === 'am' ? [h % 12] : h > 12 ? [h] : [h % 12, h % 12 + 12]
  const ist = new Date(now.getTime() + IST)
  const days = TOMORROW.test(text) ? [1] : [0, 1]
  return hours.flatMap(hh => days.map(d => Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + d, hh, min) - IST)
    .filter(ms => ms > now.getTime()).slice(0, 1)).sort((x, y) => x - y)
}

// A deadline with what it is for. A flight or train is measured to an airport / station (`at` = the one the user named), and
// the user must be there `buffer` min before (domestic flight 90, train 20); "airport by 6" is the time to be there. Ride 2026-10-18:
// a 3 pm flight was compared with arrival at the hotel.
export type Deadline = { times: number[]; what: string; hub?: 'airport' | 'railway station'; buffer: number; at?: string }
const KINDS: [RegExp, string, Deadline['hub'], number][] = [[/\b(flight|plane|fly|flying)\b/i, 'flight', 'airport', 90],
  [/\btrain\b/i, 'train', 'railway station', 20], [/\b(airport|boarding)\b/i, 'airport', 'airport', 0], [/\b(railway|station)\b/i, 'station', 'railway station', 0]]
// "from navi mumbai", "at Pune station": the place after from / at, up to a stop word, a time or the end.
const HUB_AT = /\b(?:from|at)\s+(?:the\s+)?([a-z][a-z .'-]*?)\s*(?:international\s+)?(?:airport|railway station|station|junction|terminus)?\s*(?=$|[,.?!]|\s(?:at|by|on|to|will|and|for|tomorrow|today|kal|\d))/i
export function deadlineOf(text: string, now = new Date(), prior = ''): Deadline | null {
  const times = deadlineTimes(text, now, prior)
  if (!times.length) return null
  const [, what, hub, buffer] = KINDS.find(([re]) => re.test(text)) ?? KINDS.find(([re]) => re.test(prior)) ?? [, 'arrive', undefined, 0]
  const at = hub && text.match(HUB_AT)?.[1].trim()
  return { times, what, hub, buffer, ...(at && !/^(home|hotel|my|our|it|this|that|least|time|night)$/i.test(at) && { at }) }
}
// A one-moment deadline as a trip note, and back: it outlives the last-10-messages window (the 3 pm flight said at 11:22 was gone at 13:15).
export const deadlineNote = (d: Deadline) => `Deadline: ${d.what} ${istIso(d.times[0]).slice(0, 16).replace('T', ' ')} IST${d.at ? ` from ${d.at}` : ''}`
export function noteDeadline(note: string): Deadline | null {
  const m = note.match(/^Deadline: (\w+) (\d{4}-\d\d-\d\d) (\d\d:\d\d) IST(?: from (.+))?$/)
  const k = m && KINDS.find(k => k[1] === m[1])
  return m ? { times: [Date.parse(`${m[2]}T${m[3]}:00+05:30`)], what: m[1], hub: k?.[2], buffer: k?.[3] ?? 0, ...(m[4] && { at: m[4] }) } : null
}

const iso = (d: Date) => d.toISOString().slice(0, 16) + ':00+05:30' // d holds IST wall clock in UTC fields

// A moment as ISO 8601 in IST, e.g. "2026-10-05T17:40:02+05:30" (trip id, fix, reached_at, search time).
export const istIso = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 19) + '+05:30'
