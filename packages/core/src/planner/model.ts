import { cachedPost as post } from './cache.ts'

// The planner's own model calls: temperature 0 and plain reading, so not llm.ts (its tiers, tools and bring-your-own key).
// parse reads the request; read reads web snippets and writes the one-line reasons. Both are on the relay's allowlist.
export const PLANNER_MODELS = { parse: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', read: 'nvidia/nemotron-3-super-120b-a12b' } as const

export async function complete(model: string, system: string, user: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
  const res = await post<any>('/llm', {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false }, // reasoning off: faster, same answers here
    ...(opts.maxTokens && { max_tokens: opts.maxTokens }),
    ...(opts.json && { response_format: { type: 'json_object' } }),
  })
  return res.choices[0].message.content ?? ''
}
