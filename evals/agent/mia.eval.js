// AGENT-EVALS.1 — live replay evals for Mia. Run with: npm run eval:agent
//
// Calls the REAL Anthropic API with the production prompt + tools
// (claude-sonnet-4-6, ~$0.10–0.30 per full run thanks to the cached
// tool prefix). Needs ANTHROPIC_API_KEY in the environment or
// .env.local — without it every scenario SKIPS with a notice, so this
// file is safe to invoke anywhere. Deliberately NOT part of `npm test`
// or CI: model calls are non-deterministic and cost money. Run it
// before merging any change to src/lib/agent/prompt.js or the agent
// tool definitions.
//
// A transcript of the last run lands in evals/output/last-run.md for
// eyeballing tone alongside the hard assertions.

import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SCENARIOS } from './scenarios'
import { runScenario } from './runner'
import { evaluateOutcome } from './assertions'

const API_KEY = process.env.ANTHROPIC_API_KEY
const report = []

describe.skipIf(!API_KEY)('Mia replay evals (live model)', () => {
  if (!API_KEY) return

  for (const scenario of SCENARIOS) {
    it(scenario.id, { timeout: 90_000, retry: 1 }, async () => {
      const outcome = await runScenario(scenario, { apiKey: API_KEY })
      const result = evaluateOutcome(scenario.expect, outcome)

      report.push({ scenario, outcome, result })

      if (!result.pass) {
        // Surface the full picture in the failure output.
        const calls = outcome.toolCalls.map(c => `${c.name}(${JSON.stringify(c.input)})`).join('\n    ')
        console.error(
          `\n✗ ${scenario.id} — ${scenario.why}\n` +
          `  tool calls:\n    ${calls || '(none)'}\n` +
          `  action: ${outcome.action}${outcome.action === 'handoff' ? ` (${outcome.reason})` : ''}\n` +
          `  reply: ${outcome.text}\n` +
          `  failures:\n    - ${result.failures.join('\n    - ')}\n`,
        )
      }
      expect(result.failures, scenario.why).toEqual([])
    })
  }
})

if (!API_KEY) {
  it('skipped — no ANTHROPIC_API_KEY', () => {
    console.warn(
      '[agent-evals] ANTHROPIC_API_KEY is not set. Add it to .env.local '
      + '(same key the Vercel deployment uses) and re-run npm run eval:agent.',
    )
    expect(true).toBe(true)
  })
}

afterAll(() => {
  if (report.length === 0) return
  const lines = [`# Mia eval run — ${new Date().toISOString()}`, '']
  for (const { scenario, outcome, result } of report) {
    lines.push(`## ${result.pass ? '✅' : '❌'} ${scenario.id}`)
    lines.push(`_${scenario.why}_`, '')
    lines.push(`- last inbound: ${scenario.history.filter(h => h.direction === 'inbound').at(-1)?.body}`)
    lines.push(`- tool calls: ${outcome.toolCalls.map(c => c.name).join(', ') || '(none)'}`)
    lines.push(`- action: ${outcome.action}${outcome.action === 'handoff' ? ` — ${outcome.reason}` : ''}`)
    if (outcome.text) lines.push(`- reply: ${outcome.text.replace(/\n/g, ' ')}`)
    if (!result.pass) lines.push(`- **failures:** ${result.failures.join(' | ')}`)
    lines.push('')
  }
  const passed = report.filter(r => r.result.pass).length
  lines.push(`**${passed}/${report.length} passed**`)
  const out = path.join(process.cwd(), 'evals', 'output')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'last-run.md'), lines.join('\n'))
})
