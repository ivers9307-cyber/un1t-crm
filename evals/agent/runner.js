// AGENT-EVALS.1 — replay runner for Mia.
//
// Reproduces the PRODUCTION request assembly byte-for-byte where it
// matters: the real buildCustomerSystemPrompt, the real tool definitions
// (imported from auto-reply.js so the surface can never drift), the same
// model / max_tokens / iteration cap / history formatting. The only
// substitution is tool EXECUTION: scenarios provide canned results, so
// no Supabase, no WhatsApp, no side effects — what's under test is the
// prompt + tool definitions + model behaviour. The IO executors have
// their own unit tests.
//
// `callModel` is injectable so the loop mechanics are unit-testable in
// CI without the network; the live path POSTs the same body shape as
// src/lib/agent/auto-reply.js.

import { buildCustomerSystemPrompt } from '@/lib/agent/prompt'
import { formatHistoryForClaude, parseAgentResponse } from '@/lib/agent/core'
import { ALL_AGENT_TOOLS, AGENT_MODEL, MAX_TOOL_ITERATIONS } from '@/lib/agent/auto-reply'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// Same shape as production: mark the LAST tool ephemeral so the whole
// byte-identical tool block caches across the eval run (saves ~90% of
// input cost from scenario 2 onward).
const CACHED_TOOLS = ALL_AGENT_TOOLS.map((tool, i) =>
  i === ALL_AGENT_TOOLS.length - 1
    ? { ...tool, cache_control: { type: 'ephemeral' } }
    : tool,
)

export function buildScenarioRequest(scenario) {
  const p = scenario.prompt || {}
  const system = buildCustomerSystemPrompt({
    businessName: p.businessName ?? 'UN1T',
    locationName: p.locationName ?? 'UN1T Stillorgan',
    agentName: p.agentName ?? 'Mia',
    membershipUrl: p.membershipUrl ?? null,
    tone: p.tone ?? null,
    extraRules: p.extraRules ?? null,
    knowledge: p.knowledge ?? [],
    // MIA-CARDS.1 — card sets the scenario's prompt should offer (production
    // passes these on the WhatsApp channel only; evals replay that channel).
    cardSets: p.cardSets ?? [],
    // Fixed date so scenario wording ("tomorrow") stays coherent run to run.
    today: p.today ?? '2026-06-13',
    identityPreverified: !!p.identityPreverified,
  })
  const messages = formatHistoryForClaude(scenario.history || [], { maxMessages: 20 })
  return { system, messages }
}

async function liveCallModel({ system, messages, apiKey }) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 600,
      system,
      messages,
      tools: CACHED_TOOLS,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`)
  }
  return res.json()
}

function dispatchMock(scenario, name, input, outcome) {
  const mock = scenario.tools?.[name]
  if (mock === undefined) {
    outcome.unexpectedTools.push(name)
    return { error: 'This tool is not available right now.' }
  }
  return typeof mock === 'function' ? mock(input) : mock
}

/**
 * Run one scenario through the real agent loop.
 * @returns outcome { toolCalls, unexpectedTools, action, text, reason, options, iterationsExhausted, turns }
 */
export async function runScenario(scenario, { apiKey, callModel = liveCallModel } = {}) {
  const { system, messages } = buildScenarioRequest(scenario)
  const outcome = {
    toolCalls: [],
    unexpectedTools: [],
    iterationsExhausted: false,
    turns: [],
  }

  let modelText = ''
  let iterations = MAX_TOOL_ITERATIONS
  let done = false
  while (iterations-- > 0 && !done) {
    const data = await callModel({ system, messages, apiKey })
    const content = data.content || []
    outcome.turns.push(content)

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content })
      const toolResults = []
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        outcome.toolCalls.push({ name: block.name, input: block.input || {} })
        const result = dispatchMock(scenario, block.name, block.input || {}, outcome)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        })
      }
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    modelText = content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    done = true
  }
  if (!done) outcome.iterationsExhausted = true

  const parsed = parseAgentResponse(modelText)
  outcome.action = parsed.action
  outcome.text = parsed.text
  outcome.reason = parsed.reason
  if (parsed.options) outcome.options = parsed.options
  return outcome
}
