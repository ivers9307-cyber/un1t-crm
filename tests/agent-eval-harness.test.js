// AGENT-EVALS.1 — CI coverage for the eval harness itself (no network).
// The live evals (evals/agent/mia.eval.js) hit the real API and run via
// npm run eval:agent; these tests pin the assertion engine and the
// runner's loop mechanics with a scripted fake model so a harness bug
// can't masquerade as a prompt regression.
import { describe, it, expect } from 'vitest'
import { evaluateOutcome } from '../evals/agent/assertions'
import { runScenario, buildScenarioRequest } from '../evals/agent/runner'
import { SCENARIOS } from '../evals/agent/scenarios'
import { ALL_AGENT_TOOLS, MAX_TOOL_ITERATIONS } from '../src/lib/agent/auto-reply'

const baseOutcome = {
  toolCalls: [],
  unexpectedTools: [],
  iterationsExhausted: false,
  action: 'reply',
  text: 'Hi! I’m Mia, the AI assistant for UN1T.',
  reason: 'ok',
}

describe('evaluateOutcome', () => {
  it('passes a clean outcome with matching expectations', () => {
    const res = evaluateOutcome(
      { handoff: false, match: ['\\bMia\\b', 'AI'], maxToolCalls: 0 },
      baseOutcome,
    )
    expect(res.pass).toBe(true)
    expect(res.failures).toEqual([])
  })

  it('flags missing required tool calls and forbidden ones', () => {
    const res = evaluateOutcome(
      { mustCall: ['book_class'], mustNotCall: ['request_cancellation'] },
      {
        ...baseOutcome,
        toolCalls: [{ name: 'request_cancellation', input: {} }],
      },
    )
    expect(res.pass).toBe(false)
    expect(res.failures.join(' ')).toContain('expected tool call: book_class')
    expect(res.failures.join(' ')).toContain('forbidden tool was called: request_cancellation')
  })

  it('enforces never-say rules and required tokens on the reply text', () => {
    const res = evaluateOutcome(
      { match: ['un1tdublin\\.com/join'], notMatch: ['€\\s?\\d'] },
      { ...baseOutcome, text: 'Memberships are €120/month, sign up at un1tdublin.com/join' },
    )
    expect(res.pass).toBe(false)
    expect(res.failures).toHaveLength(1)
    expect(res.failures[0]).toContain('forbidden')
  })

  it('grades handoff expectations both ways', () => {
    const handoff = { ...baseOutcome, action: 'handoff', text: '', reason: 'no knowledge' }
    expect(evaluateOutcome({ handoff: true }, handoff).pass).toBe(true)
    expect(evaluateOutcome({ handoff: false }, handoff).pass).toBe(false)
    expect(evaluateOutcome({ handoff: true }, baseOutcome).pass).toBe(false)
  })

  it('anyOf passes when one branch passes and fails when none do', () => {
    const safeReply = { ...baseOutcome, text: 'I’ll check with the team and get back to you!' }
    const expectAnyOf = {
      anyOf: [
        { handoff: true },
        { notMatch: ['\\d{1,2}[:.]\\d{2}'], match: ['team'] },
      ],
    }
    expect(evaluateOutcome(expectAnyOf, safeReply).pass).toBe(true)
    const invented = { ...baseOutcome, text: 'We open at 06:30 every day!' }
    expect(evaluateOutcome(expectAnyOf, invented).pass).toBe(false)
  })

  it('always fails on unexpected (unmocked) tool calls and iteration exhaustion', () => {
    expect(evaluateOutcome({}, { ...baseOutcome, unexpectedTools: ['book_event'] }).pass).toBe(false)
    expect(evaluateOutcome({}, { ...baseOutcome, iterationsExhausted: true }).pass).toBe(false)
  })

  it('argMatch checks a field on the first matching call', () => {
    const outcome = {
      ...baseOutcome,
      toolCalls: [{ name: 'book_class', input: { event_id: '64aa00000000000000000002' } }],
    }
    expect(evaluateOutcome({ argMatch: [{ tool: 'book_class', field: 'event_id', pattern: '^64aa' }] }, outcome).pass).toBe(true)
    expect(evaluateOutcome({ argMatch: [{ tool: 'book_class', field: 'event_id', pattern: '^ffff' }] }, outcome).pass).toBe(false)
  })
})

describe('runScenario (fake model — loop mechanics)', () => {
  const scenario = {
    id: 'fake',
    prompt: { identityPreverified: true },
    history: [{ direction: 'inbound', body: 'Book me a class' }],
    tools: { list_upcoming_classes: { classes: [{ event_id: 'x', name: 'LIFT45' }] } },
    expect: {},
  }

  it('dispatches mocked tools, records calls, and parses the final reply', async () => {
    const turns = [
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1', name: 'list_upcoming_classes', input: { day: 'tomorrow' } },
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'We have LIFT45 tomorrow — want me to book it?' }],
      },
    ]
    let call = 0
    const seenBodies = []
    const outcome = await runScenario(scenario, {
      callModel: async ({ system, messages }) => {
        seenBodies.push({ system, messages: structuredClone(messages) })
        return turns[call++]
      },
    })
    expect(outcome.toolCalls).toEqual([{ name: 'list_upcoming_classes', input: { day: 'tomorrow' } }])
    expect(outcome.unexpectedTools).toEqual([])
    expect(outcome.action).toBe('reply')
    expect(outcome.text).toContain('LIFT45')
    // The second call must carry the assistant turn + the stringified tool result.
    const second = seenBodies[1].messages
    expect(second.at(-2).role).toBe('assistant')
    expect(second.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' })
    expect(second.at(-1).content[0].content).toContain('LIFT45')
  })

  it('records unmocked tools as unexpected and still completes', async () => {
    const turns = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'book_event', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done-ish.' }] },
    ]
    let call = 0
    const outcome = await runScenario(scenario, { callModel: async () => turns[call++] })
    expect(outcome.unexpectedTools).toEqual(['book_event'])
  })

  it('marks iteration exhaustion and parses it as a handoff (matches production)', async () => {
    const toolTurn = {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'list_upcoming_classes', input: {} }],
    }
    const outcome = await runScenario(scenario, { callModel: async () => toolTurn })
    expect(outcome.iterationsExhausted).toBe(true)
    expect(outcome.action).toBe('handoff')
  })

  it('parses the [[HANDOFF]] sentinel like production', async () => {
    const outcome = await runScenario(scenario, {
      callModel: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '[[HANDOFF]] needs a human for billing' }],
      }),
    })
    expect(outcome.action).toBe('handoff')
    expect(outcome.reason).toContain('billing')
  })
})

describe('scenario fixtures stay valid', () => {
  it('every scenario builds a real request (prompt renders, history non-empty)', () => {
    for (const s of SCENARIOS) {
      const { system, messages } = buildScenarioRequest(s)
      expect(system, s.id).toContain('Mia')
      expect(messages.length, s.id).toBeGreaterThan(0)
      expect(messages[0].role, s.id).toBe('user')
    }
  })

  it('every mocked or referenced tool name exists on the production tool surface', () => {
    const names = new Set(ALL_AGENT_TOOLS.map(t => t.name))
    for (const s of SCENARIOS) {
      for (const mocked of Object.keys(s.tools || {})) {
        expect(names.has(mocked), `${s.id} mocks unknown tool ${mocked}`).toBe(true)
      }
      for (const n of [...(s.expect.mustCall || []), ...(s.expect.mustNotCall || [])]) {
        expect(names.has(n), `${s.id} references unknown tool ${n}`).toBe(true)
      }
    }
  })

  it('regex assertions compile', () => {
    for (const s of SCENARIOS) {
      const all = [
        ...(s.expect.match || []), ...(s.expect.notMatch || []),
        ...(s.expect.anyOf || []).flatMap(b => [...(b.match || []), ...(b.notMatch || [])]),
      ]
      for (const p of all) expect(() => new RegExp(p, 'i'), `${s.id}: /${p}/`).not.toThrow()
    }
  })

  it('the production iteration cap is what the runner loops on', () => {
    expect(MAX_TOOL_ITERATIONS).toBe(4)
  })
})
