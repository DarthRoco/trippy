import { post } from '../api.ts'

// Session cache for the planner's relay calls: the same request in this page session gets the same answer, so a replan
// (a "nothing fits" fix, an edited field, a second plan for the same area) does not pay Google, Tavily or Nemotron again.
// Answers are only read, never changed, by the callers. In memory only and gone on reload, as Google's terms allow for
// Places data. A failed call is not kept, so it can be tried again.
// ponytail: no size cap; a session plans a handful of outings. Add an LRU if sessions grow long.
const seen = new Map<string, Promise<unknown>>()
export const cache = { on: true } // the offline checks turn it off to fake different answers to the same request

export function cachedPost<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  if (!cache.on) return post<T>(path, body, headers)
  const key = path + JSON.stringify(body) + JSON.stringify(headers)
  let p = seen.get(key)
  if (!p) {
    p = post<T>(path, body, headers)
    seen.set(key, p)
    p.catch(() => seen.delete(key))
  }
  return p as Promise<T>
}
