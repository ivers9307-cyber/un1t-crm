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

  // MIA-REVIEW.3 (3.20) — the runner always captured outcome.options and no
  // assertion class read it, so the prompt's tap-button rules were unguarded.
  describe('options ([[OPTIONS]]) assertions', () => {
    const withOptions = (options) => ({ ...baseOutcome, options })

    it('optionsRequired fails when no buttons were emitted', () => {
      const res = evaluateOutcome({ optionsRequired: true }, baseOutcome)
      expect(res.pass).toBe(false)
      expect(res.failures[0]).toContain('expected tap options')
    })
    it('optionsRequired passes on a valid 2-10 button set', () => {
      expect(evaluateOutcome({ optionsRequired: true }, withOptions(['06:30 LIFT45', '07:15 SWEAT45'])).pass).toBe(true)
    })
    it('optionsRequired enforces the count and label-length caps', () => {
      expect(evaluateOutcome({ optionsRequired: true }, withOptions(['only one'])).pass).toBe(false)
      expect(evaluateOutcome({ optionsRequired: true }, withOptions(['ok', 'this label is far too long for a button'])).pass).toBe(false)
    })
    it('optionsRequired:false flags unexpected buttons', () => {
      expect(evaluateOutcome({ optionsRequired: false }, withOptions(['a', 'b'])).pass).toBe(false)
      expect(evaluateOutcome({ optionsRequired: false }, baseOutcome).pass).toBe(true)
    })
    it('optionsNotMatch keeps a FULL class off a tap button', () => {
      const res = evaluateOutcome({ optionsNotMatch: ['SWEAT'] }, withOptions(['06:30 LIFT45', '07:15 SWEAT45']))
      expect(res.pass).toBe(false)
      expect(res.failures[0]).toContain('forbidden')
      expect(evaluateOutcome({ optionsNotMatch: ['SWEAT'] }, withOptions(['06:30 LIFT45'])).pass).toBe(true)
    })
    it('optionsMatch requires at least one matching label', () => {
      expect(evaluateOutcome({ optionsMatch: ['LIFT'] }, withOptions(['06:30 LIFT45', 'Something else'])).pass).toBe(true)
      expect(evaluateOutcome({ optionsMatch: ['LIFT'] }, withOptions(['Something else'])).pass).toBe(false)
    })
  })

  // MIA-SONNET5 — "she still replied in text, she didn't just fire a tool and
  // go silent" was previously approximated by requiring specific nouns in the
  // reply, which broke the moment the model's phrasing got terser without
  // getting worse. minReplyChars states the actual requirement.
  it('minReplyChars requires a substantive text reply', () => {
    const withText = (text) => ({ ...baseOutcome, text })
    expect(evaluateOutcome({ minReplyChars: 20 }, withText('Sent! Let me know if you want help picking one.')).pass).toBe(true)
    expect(evaluateOutcome({ minReplyChars: 20 }, withText('ok')).pass).toBe(false)
    expect(evaluateOutcome({ minReplyChars: 20 }, withText('')).pass).toBe(false)
    // Whitespace is not a reply.
    expect(evaluateOutcome({ minReplyChars: 20 }, withText('          \n   ')).pass).toBe(false)
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
      // MIA-REVIEW.3 — `system` is now production's CACHED BLOCK form
      // (buildCachedSystem), not a flattened string.
      expect(Array.isArray(system), s.id).toBe(true)
      expect(system[0], s.id).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } })
      expect(system.map(b => b.text).join('\n'), s.id).toContain('Mia')
      expect(messages.length, s.id).toBeGreaterThan(0)
      expect(messages[0].role, s.id).toBe('user')
    }
  })

  // MIA-REVIEW.3 (3.3) — buildScenarioRequest forwarded only
  // identityPreverified, so the AGENT-AUTH.3 (number on >1 account) and
  // known-contact prompt blocks could never render in an eval: the harness
  // structurally could not express the scenario.
  it('forwards multipleAccounts and knownContact into the prompt', () => {
    const text = (s) => s.map(b => b.text).join('\n')
    const dupe = buildScenarioRequest({ prompt: { multipleAccounts: true }, history: [{ direction: 'inbound', body: 'hi' }] })
    expect(text(dupe.system)).toMatch(/more than one account/i)
    const known = buildScenarioRequest({ prompt: { knownContact: { firstName: 'Edel', hasEmail: true } }, history: [{ direction: 'inbound', body: 'hi' }] })
    expect(text(known.system)).toContain('Edel')
    const plain = buildScenarioRequest({ history: [{ direction: 'inbound', body: 'hi' }] })
    expect(text(plain.system)).not.toMatch(/more than one account/i)
  })

  it('the live request carries production output_config.effort', async () => {
    // Not a live call — assert the runner threads the effort through to the
    // model caller, which is where production diverged (evals always ran at
    // the API default, so "eval before switching to effort:low" was impossible).
    let seen = null
    await runScenario(
      { id: 'x', history: [{ direction: 'inbound', body: 'hi' }], tools: {}, expect: {} },
      {
        effort: 'low',
        callModel: async (args) => { seen = args; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } },
      },
    )
    expect(seen.effort).toBe('low')
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
      const branch = (b) => [
        ...(b.match || []), ...(b.notMatch || []),
        ...(b.optionsMatch || []), ...(b.optionsNotMatch || []),
      ]
      const all = [...branch(s.expect), ...(s.expect.anyOf || []).flatMap(branch)]
      for (const p of all) expect(() => new RegExp(p, 'i'), `${s.id}: /${p}/`).not.toThrow()
    }
  })

  it('the production iteration cap is what the runner loops on', () => {
    // 6 since the Mia conversation-review fixes — a booking turn can chain
    // verify → list → book → re-list and still owe a final text reply.
    expect(MAX_TOOL_ITERATIONS).toBe(6)
  })
})
