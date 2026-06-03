// FLOW-GRAPH Phase 3 — runs the flow agent: ask → Claude (forced
// emit_sequence_graph tool) → shape-check + validateGraph → self-correct retry.
// Matches the repo's raw-fetch Anthropic convention (see assistant/chat). The
// runner + publish path are untouched; the result is only ever saved as a draft.
//
// Model: Sonnet 4.6, not Opus — emitting a structured graph from an ask is a
// constrained generation task, and the validateGraph + self-correct loop is the
// real quality gate, so Opus-tier reasoning isn't worth the ~2x token cost here.
import { parseGraphShape, validateGraph } from '../graph/index.js'
import { EMIT_TOOL, buildAgentSystemPrompt, buildAgentUserMessage, buildFixMessage } from './prompt.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const AGENT_MODEL = 'claude-sonnet-4-6'
const MAX_ATTEMPTS = 3

async function callClaude(apiKey, system, messages) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 8192,
      system,
      messages,
      tools: [EMIT_TOOL],
      tool_choice: { type: 'tool', name: EMIT_TOOL.name },
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 500)}`)
  return res.json()
}

/**
 * @returns {Promise<{ ok:boolean, graph?:object, validation?:object, exhausted?:boolean, error?:string }>}
 * ok:true + validation.ok → a clean, valid draft. ok:true + exhausted → a
 * shape-valid draft the operator can finish in the builder. ok:false → hard fail.
 */
export async function runFlowAgent({ apiKey, prompt, trigger }) {
  if (!apiKey) return { ok: false, error: 'AI is not configured (no API key).' }
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'Describe the sequence you want.' }

  const system = buildAgentSystemPrompt()
  const messages = [{ role: 'user', content: buildAgentUserMessage(prompt, trigger) }]
  let lastGraph = null
  let lastValidation = null
  let lastName = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let data
    try {
      data = await callClaude(apiKey, system, messages)
    } catch (e) {
      return { ok: false, error: e?.message || 'AI request failed.' }
    }

    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === EMIT_TOOL.name)
    if (!toolUse) return { ok: false, error: 'The AI did not return a flow.' }

    if (typeof toolUse.input?.name === 'string' && toolUse.input.name.trim()) lastName = toolUse.input.name.trim().slice(0, 200)

    const shape = parseGraphShape(toolUse.input)
    if (shape.ok) {
      lastGraph = shape.data
      lastValidation = validateGraph(lastGraph)
      if (lastValidation.ok) return { ok: true, graph: lastGraph, validation: lastValidation, name: lastName }
    }

    // Feed the problem back and let it self-correct (shape error or semantic errors).
    const feedback = shape.ok ? buildFixMessage(lastValidation.errors) : buildFixMessage([{ message: shape.error.message }])
    messages.push({ role: 'assistant', content: data.content })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: feedback }] })
  }

  // Ran out of attempts. Hand back the last shape-valid draft (if any) + its
  // validation so the operator can finish it in the builder; else hard fail.
  if (lastGraph) return { ok: true, graph: lastGraph, validation: lastValidation, name: lastName, exhausted: true }
  return { ok: false, error: 'The AI couldn’t produce a usable flow — try rephrasing.' }
}
