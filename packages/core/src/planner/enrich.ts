import { cachedPost as post } from './cache.ts'
import { complete, PLANNER_MODELS } from './model.ts'
import { INHERENT, maps_url, stopWants } from './types.ts'
import type { Constraints, PlannerPlace } from './types.ts'

export const TOP_PER_TYPE = 5
export const MIN_CLAIM_WORDS = 4 // "Quiet" alone is not evidence
// Must-have keyword -> (Place field, label). Google's own answer beats a web search for these.
export const GOOGLE_FIELDS: Record<string, ['outdoor_seating' | 'parking', string]> = { parking: ['parking', 'parking'], outdoor: ['outdoor_seating', 'outdoor seating'] }

export const PROMPT = `You read web snippets about one place and judge attributes. Use only the snippets.
Return only a JSON object: {"attributes": {"<attribute>": true|false|null, ...}, "evidence": [{"attribute": "<attribute>", "claim": "<short claim>", "url": "<one of the snippet urls>"}]}
Use null when the snippets say nothing. Every true or false needs one evidence item with a url copied from the snippets.`

// The model may wrap its JSON in reasoning or prose: cut from the first { to the last }.
function extractJson(text: string): any {
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
}

// Answer wants that Places data covers. Returns the wants it answered.
export function googleFacts(place: PlannerPlace, wants: string[]): Set<string> {
  const answered = new Set<string>()
  for (const w of wants)
    for (const [key, [field, label]] of Object.entries(GOOGLE_FIELDS)) {
      const value = place[field]
      if (w.includes(key) && value !== undefined) {
        place.attributes[w] = value
        place.evidence.push({ attribute: w, claim: `Google Maps lists ${value ? '' : 'no '}${label} here`, url: maps_url(place) })
        answered.add(w)
      }
    }
  return answered
}

// Fill place.attributes and place.evidence in place. Failures leave the place unenriched.
export async function enrichPlace(place: PlannerPlace, area: string, wants: string[], web = true): Promise<void> {
  const answered = googleFacts(place, wants)
  wants = wants.filter(w => !answered.has(w))
  if (!wants.length || !web) return // web = false keeps tests off Tavily, which has a small monthly allowance
  let data: any, known: Set<string>
  try {
    const res = await post<any>('/search/evidence', { query: `${place.name} ${area} ` + wants.join(' ') })
    const results: { url: string; content?: string }[] = (res.results ?? []).slice(0, 4)
    if (!results.length) return
    const snippets = results.map(r => `URL: ${r.url}\n${(r.content ?? '').slice(0, 600)}`).join('\n\n')
    const out = await complete(PLANNER_MODELS.read, PROMPT, `Place: ${place.name}, ${area}\nAttributes to judge: ${wants.join(', ')}\n\n${snippets}`, { maxTokens: 700 })
    data = extractJson(out)
    known = new Set(results.map(r => r.url))
  } catch {
    return
  }
  const cited = new Map<string, any>(
    (data.evidence ?? [])
      .filter((e: any) => known.has(e?.url) && String(e.claim ?? '').split(/\s+/).filter(Boolean).length >= MIN_CLAIM_WORDS)
      .map((e: any) => [String(e.attribute).toLowerCase(), e]))
  for (const [name, value] of Object.entries<any>(data.attributes ?? {})) {
    // Keep only attributes we asked about, each with a source.
    const attr = name.toLowerCase()
    if ((value === true || value === false) && wants.includes(attr) && cited.has(attr)) {
      place.attributes[attr] = value
      place.evidence.push(cited.get(attr))
    }
  }
}

// Trims each list to the top candidates in place, then enriches each distinct place once, in parallel.
export async function enrich(candidates: PlannerPlace[][], c: Constraints, web = true): Promise<void> {
  const wants = new Map<string, Set<string>>()
  const copies = new Map<string, PlannerPlace[]>()
  c.stops.forEach((t, i) => {
    candidates[i].splice(TOP_PER_TYPE)
    for (const p of candidates[i]) {
      const set = wants.get(p.place_id) ?? new Set<string>()
      for (const w of [...c.must_haves.map(m => m.toLowerCase()), ...(INHERENT[t] ?? []), ...stopWants(t, c)]) set.add(w)
      wants.set(p.place_id, set)
      copies.set(p.place_id, [...(copies.get(p.place_id) ?? []), p])
    }
  })
  await Promise.all([...copies].map(([id, ps]) => enrichPlace(ps[0], c.area, [...wants.get(id)!].sort(), web)))
  // Share results with duplicate Place objects of the same venue.
  for (const [first, ...others] of copies.values()) for (const o of others) { o.attributes = first.attributes; o.evidence = first.evidence }
}
