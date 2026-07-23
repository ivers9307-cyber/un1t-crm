// HYROX-TC.1 — the ONE IO seam. Calls the Anthropic Messages API, extracts the
// text, parses JSON, validates with the hyrox schema, retries ONCE on failure.
// fetchImpl + apiKey are injectable so this is testable without a network.
import { buildArcPrompt, buildExpansionPrompt } from './prompt'
import { parseArc, parseSession } from './schema'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
// Confirm against the current model list (claude-api skill). Batch generation
// can afford a higher tier than Mia's chat model (spec §9).
export const HYROX_MODEL = 'claude-sonnet-4-6'

async function callClaude({ system, user, maxTokens = 1500, fetchImpl = fetch, apiKey = process.env.ANTHROPIC_API_KEY }) {
  if (!apiKey) return { ok: false, error: new Error('missing ANTHROPIC_API_KEY') }
  const res = await fetchImpl(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: HYROX_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  })
  if (!res.ok) return { ok: false, error: new Error(`anthropic ${res.status}`) }
  const data = await res.json()
  const text = Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : ''
  return { ok: true, text }
}

// Tolerant: strip a ```json code fence and any surrounding prose, then parse.
// Defense-in-depth so a stray fence/preamble never fails an otherwise-valid arc.
function tryJson(text) {
  if (typeof text !== 'string') return null
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try { return JSON.parse(stripped) } catch { /* fall through to extraction */ }
  const start = stripped.search(/[[{]/)
  const end = Math.max(stripped.lastIndexOf(']'), stripped.lastIndexOf('}'))
  if (start !== -1 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)) } catch { return null }
  }
  return null
}

// Generic: build -> call -> parse-json -> validate, with ONE retry.
async function generateValidated({ system, user, maxTokens, validate, opts }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = opts.caller
      ? await opts.caller({ system, user, maxTokens })
      : await callClaude({ system, user, maxTokens, ...opts })
    if (!call.ok) { if (attempt === 1) return call; continue }
    const parsed = validate(tryJson(call.text) ?? {})
    if (parsed.ok) return parsed
    if (attempt === 1) return { ok: false, error: parsed.error }
  }
  return { ok: false, error: new Error('unreachable') }
}

// A full 12-week arc / a full session + board are large structured JSON. Under-
// budgeting max_tokens truncates the JSON mid-structure so it never parses — the
// 2026-07-23 arc_generation_failed had output_tokens pinned at exactly 1500.
export async function generateArc(input, opts = {}) {
  const { system, user } = buildArcPrompt(input)
  return generateValidated({ system, user, maxTokens: 8000, validate: parseArc, opts })
}

export async function expandSession(input, opts = {}) {
  const { system, user } = buildExpansionPrompt(input)
  return generateValidated({ system, user, maxTokens: 4000, validate: parseSession, opts })
}
