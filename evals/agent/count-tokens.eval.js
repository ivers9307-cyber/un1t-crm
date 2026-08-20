// Throwaway measurement (MIA-SONNET5) — not a gate, deleted before merge.
// Two questions this answers with evidence rather than guesswork:
//   1. how much the new tokenizer grows Mia's real request prefix, and
//   2. how many output tokens adaptive thinking actually spends on a real
//      Mia turn at each effort level — which is what max_tokens must cover.
//   npx vitest run --config vitest.evals.config.mjs evals/agent/count-tokens.eval.js --reporter=verbose
import { it, expect } from 'vitest'
import { buildScenarioRequest } from './runner.js'
import { SCENARIOS } from './scenarios.js'
import { CACHED_ACCOUNT_TOOLS } from '@/lib/agent/auto-reply'

const key = process.env.ANTHROPIC_API_KEY

async function count(model, system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system, messages, tools: CACHED_ACCOUNT_TOOLS }),
  })
  const body = await res.json()
  return res.ok ? body.input_tokens : `ERR ${res.status}`
}

async function call(model, system, messages, extra) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 8192, system, messages, tools: CACHED_ACCOUNT_TOOLS, ...extra }),
  })
  const body = await res.json()
  if (!res.ok) return { err: `${res.status} ${JSON.stringify(body).slice(0, 200)}` }
  const thinking = (body.content || []).filter(b => b.type === 'thinking')
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
  const tools = (body.content || []).filter(b => b.type === 'tool_use').map(b => b.name)
  return {
    out: body.usage?.output_tokens,
    stop: body.stop_reason,
    thinkingBlocks: thinking.length,
    tools,
    textLen: text.length,
  }
}

it('prefix growth under the new tokenizer', async () => {
  const rows = []
  for (const scenario of SCENARIOS.slice(0, 4)) {
    const { system, messages } = buildScenarioRequest(scenario)
    const a = await count('claude-sonnet-4-6', system, messages)
    const b = await count('claude-sonnet-5', system, messages)
    const ratio = typeof a === 'number' && typeof b === 'number' ? (b / a).toFixed(3) : '—'
    rows.push(`  4.6=${a}  s5=${b}  ratio=${ratio}`)
  }
  console.log('\nPREFIX GROWTH\n' + rows.join('\n') + '\n')
  expect(rows.length).toBe(4)
}, 120_000)

it('output-token spend per config on real Mia turns', async () => {
  // A booking-shaped scenario: the case where tool-eagerness matters most.
  const scenario = SCENARIOS.find(s => (s.tools && Object.keys(s.tools).length)) || SCENARIOS[0]
  const { system, messages } = buildScenarioRequest(scenario)
  const configs = [
    ['4.6 baseline (thinking off by omission)', 'claude-sonnet-4-6', {}],
    ['s5 thinking DISABLED', 'claude-sonnet-5', { thinking: { type: 'disabled' } }],
    ['s5 adaptive effort=low', 'claude-sonnet-5', { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }],
    ['s5 adaptive effort=medium', 'claude-sonnet-5', { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }],
    ['s5 adaptive effort=high', 'claude-sonnet-5', { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }],
  ]
  const rows = []
  for (const [label, model, extra] of configs) {
    const r = await call(model, system, messages, extra)
    rows.push(`  ${label.padEnd(40)} ${JSON.stringify(r)}`)
  }
  console.log('\nOUTPUT SPEND (max_tokens 8192, so nothing truncates)\n' + rows.join('\n') + '\n')
  expect(rows.length).toBe(configs.length)
}, 300_000)
