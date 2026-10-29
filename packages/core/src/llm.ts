import { api, post, type CallLog } from './api.ts'

// Model per call type: the one config object (DESIGN.md Models; DECISIONS day-1 checks 2-3).
// Reasoning off for anything a passenger waits on: Super picks in ~1.5 s, Ultra ranks in ~1.5 s.
export const MODELS = {
  pick: { model: 'nvidia/nemotron-3-super-120b-a12b', think: false }, // call 1: read request, pick tool + args
  rank: { model: 'nvidia/Nemotron-3-Ultra-550b-a55b', think: false }, // call 2: rank candidates, explain
  plan: { model: 'nvidia/Nemotron-3-Ultra-550b-a55b', think: true }, // planning mode, nobody waiting
} as const
export type CallType = keyof typeof MODELS

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export type ToolChoice = 'auto' | 'required' | { type: 'function'; function: { name: string } }

// Bring-your-own key (H2): an OpenAI-compatible base URL (e.g. https://api.openai.com/v1), key and model replace every
// tier and go straight from the browser, skipping our relay and its caps. The app sets it from the settings record;
// an empty key means our relay.
export const byo = { base: '', key: '', model: '' }

export async function chat(call: CallType, messages: Msg[], tools?: unknown[], toolChoice?: ToolChoice): Promise<Msg> {
  if (byo.key) return direct(messages, tools, toolChoice)
  const { model, think } = MODELS[call]
  const res = await post<any>('/llm', {
    model,
    messages,
    tools,
    tool_choice: toolChoice,
    temperature: 0.6,
    max_tokens: think ? 8192 : 2048, // reasoning tokens count too; 4096 cut planning-tier tool calls mid-JSON
    chat_template_kwargs: { enable_thinking: think },
  })
  return res.choices[0].message
}

// Only standard fields: other providers reject chat_template_kwargs, and some reject temperature or max_tokens.
// The debug log gets the call without the key.
async function direct(messages: Msg[], tools?: unknown[], toolChoice?: ToolChoice): Promise<Msg> {
  const t0 = Date.now()
  const path = byo.base.replace(/\/+$/, '') + '/chat/completions'
  const body = { model: byo.model, messages, tools, tool_choice: toolChoice }
  const e: CallLog = { path, headers: {}, body, status: 0, ms: 0 }
  try {
    const r = await fetch(path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${byo.key}` } })
    e.status = r.status
    const data = e.data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`Your key: ${r.status} ${data.error?.message ?? r.statusText}`)
    return data.choices[0].message
  } catch (err) {
    e.error = String(err)
    throw err
  } finally {
    e.ms = Date.now() - t0
    api.onCall?.(e)
  }
}
