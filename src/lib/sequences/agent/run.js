// FLOW-GRAPH Phase 3 — runs the flow agent: ask → Claude (forced
// emit_sequence_graph tool) → shape-check + validateGraph → self-correct retry.
// Matches the repo's raw-fetch Anthropic convention (see assistant/chat). The
// runner + publish path are untouched; the result is only ever saved as a draft.
//
// Model: Sonnet, not Opus — emitting a structured graph from an ask is a
// constrained generation task, and the validateGraph + self-correct loop is the
// real quality gate, so Opus-tier reasoning isn't worth the ~2x token cost here.
// MIA-SONNET5 — moved 4.6 → Sonnet 5 with the rest of the agent estate. The
// forced `tool_choice` below needs `thinking: disabled` ONLY on Bedrock; this
// repo calls the Claude API directly, where forced tool choice and adaptive
// thinking coexist. max_tokens is already 8192, so the ~31% tokenizer growth
// has ample room.
import { parseGraphShape, validateGraph, isPureTree } from '../graph/index.js'
import { EMIT_TOOL, buildAgentSystemPrompt, buildAgentUserMessage, buildFixMessage } from './prompt.js'
import { anthropicMessages } from '@/lib/anthropic'

const AGENT_MODEL = 'claude-sonnet-5'
const MAX_ATTEMPTS = 3

async function callClaude(apiKey, system, messages, locationId) {
  // SAAS4-M1 — metered via the shared wrapper (source: flow_agent).
  const { res, data } = await anthropicMessages(
    {
      model: AGENT_MODEL,
      max_tokens: 8192,
      system,
      messages,
      tools: [EMIT_TOOL],
      tool_choice: { type: 'tool', name: EMIT_TOOL.name },
    },
    { apiKey, locationId, source: 'flow_agent' }
  )
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 500)}`)
  if (!data) throw new Error('Claude API returned a non-JSON response body.')
  return data
}

/**
 * @returns {Promise<{ ok:boolean, graph?:object, validation?:object, exhausted?:boolean, error?:string }>}
 * ok:true + validation.ok → a clean, valid draft. ok:true + exhausted → a
 * shape-valid draft the operator can finish in the builder. ok:false → hard fail.
 */
export async function runFlowAgent({ apiKey, prompt, trigger, locationId = null }) {
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
      data = await callClaude(apiKey, system, messages, locationId)
    } catch (e) {
      return { ok: false, error: e?.message || 'AI request failed.' }
    }

    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === EMIT_TOOL.name)
    if (!toolUse) return { ok: false, error: 'The AI did not return a flow.' }

    if (typeof toolUse.input?.name === 'string' && toolUse.input.name.trim()) lastName = toolUse.input.name.trim().slice(0, 200)

    const shape = parseGraphShape(toolUse.input)
    let problems
    if (!shape.ok) {
      problems = [{ message: shape.error.message }]
    } else {
      lastGraph = shape.data
      lastValidation = validateGraph(lastGraph)
      problems = [...lastValidation.errors]
      // Require a pure tree so the result stays editable in the builder (the
      // editor can't represent re-convergent "diamond" graphs).
      if (!isPureTree(lastGraph)) {
        problems.push({ message: 'Two paths merge into the same step — make each branch’s yes/no path end on its own so the whole flow is a tree (no merging back).' })
      }
      if (problems.length === 0) return { ok: true, graph: lastGraph, validation: lastValidation, name: lastName }
    }

    // Feed the problems back and let it self-correct.
    messages.push({ role: 'assistant', content: data.content })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: buildFixMessage(problems) }] })
  }

  // Ran out of attempts. Hand back the last shape-valid draft (if any) + its
  // validation so the operator can finish it in the builder; else hard fail.
  if (lastGraph) return { ok: true, graph: lastGraph, validation: lastValidation, name: lastName, exhausted: true }
  return { ok: false, error: 'The AI couldn’t produce a usable flow — try rephrasing.' }
}
