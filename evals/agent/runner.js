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

import { buildCachedSystem } from '@/lib/agent/prompt'
import { formatHistoryForClaude, parseAgentResponse, resolveAgentEffort } from '@/lib/agent/core'
import {
  CACHED_ACCOUNT_TOOLS,
  AGENT_MODEL,
  AGENT_THINKING,
  MODEL_MAX_TOKENS,
  MAX_TOOL_ITERATIONS,
} from '@/lib/agent/auto-reply'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// MIA-REVIEW.3 — production sends output_config.effort (operator-tunable per
// location, default 'medium'); the runner used to omit it entirely, so every
// eval ran at the API default and the documented "eval before switching to
// effort:low" workflow was impossible. Override per run with AGENT_EFFORT=low.
export const EVAL_EFFORT = resolveAgentEffort(process.env.AGENT_EFFORT)

// MIA-HYGIENE.5 — import the production tool block rather than rebuilding one
// "in the same shape". The hand-rolled copy drifted the moment production
// moved to a 1h TTL: the run then sent tools(5m) → system(1h), and the API
// rejects a longer-lived breakpoint that follows a shorter-lived one
// ("blocks are processed in the order tools, system, messages"), so all 28
// scenarios 400'd. Same reasoning as importing the tool surface itself.
const CACHED_TOOLS = CACHED_ACCOUNT_TOOLS

export function buildScenarioRequest(scenario) {
  const p = scenario.prompt || {}
  // MIA-REVIEW.3 — the CACHED block form production sends (buildCachedSystem),
  // not a flattened string: the split point and the cache_control marker are
  // part of the request the model actually sees.
  const system = buildCachedSystem({
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
    // AGENT-AUTH.3 — the sender's number is on more than one PERSON, so Mia
    // must ask WHICH account by email and never read out what is on file.
    // Dropping this (and knownContact) made those prompt blocks unreachable
    // from the harness, so no scenario could ever test the behaviour they
    // mandate — only prompt.test.js's "the text renders" check existed.
    multipleAccounts: !!p.multipleAccounts,
    knownContact: p.knownContact ?? null,
  })
  const messages = formatHistoryForClaude(scenario.history || [], { maxMessages: 20 })
  return { system, messages }
}

async function liveCallModel({ system, messages, apiKey, effort = EVAL_EFFORT }) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    // MIA-SONNET5 — model, thinking mode and max_tokens all come from
    // production rather than being restated here. The harness is only useful
    // insofar as it sends what production sends.
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: MODEL_MAX_TOKENS,
      thinking: AGENT_THINKING,
      output_config: { effort },
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
export async function runScenario(scenario, { apiKey, callModel = liveCallModel, effort = EVAL_EFFORT } = {}) {
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
    const data = await callModel({ system, messages, apiKey, effort })
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
