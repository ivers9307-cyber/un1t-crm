import { describe, it, expect, vi } from 'vitest'
import { recordAgentDecision, compactDecisionMeta } from './decision-log.js'

function mockDb() {
  const insert = vi.fn(async () => ({ error: null }))
  return { insert, db: { from: () => ({ insert }) } }
}

describe('recordAgentDecision', () => {
  it("normalises decision: only an actual 'reply' is 'reply', everything else 'silent'", async () => {
    const { db, insert } = mockDb()
    await recordAgentDecision(db, { channel: 'whatsapp', conversationId: 'c1', decision: 'reply', reason: 'ok' })
    expect(insert.mock.calls[0][0]).toMatchObject({ channel: 'whatsapp', conversation_id: 'c1', decision: 'reply', reason: 'ok' })

    const { db: db2, insert: insert2 } = mockDb()
    await recordAgentDecision(db2, { decision: 'handoff', reason: 'quiet_hours' })
    expect(insert2.mock.calls[0][0].decision).toBe('silent')
    await recordAgentDecision(db2, { decision: undefined, reason: 'disabled' })
    expect(insert2.mock.calls[1][0].decision).toBe('silent')
  })

  it('truncates a long reason and nulls a missing one', async () => {
    const { db, insert } = mockDb()
    await recordAgentDecision(db, { decision: 'silent', reason: 'x'.repeat(500) })
    expect(insert.mock.calls[0][0].reason.length).toBeLessThanOrEqual(100)
    await recordAgentDecision(db, { decision: 'silent' })
    expect(insert.mock.calls[1][0].reason).toBeNull()
  })

  it('never throws when the insert fails', async () => {
    const db = { from: () => ({ insert: vi.fn(async () => { throw new Error('db down') }) }) }
    await expect(recordAgentDecision(db, { decision: 'reply' })).resolves.toBeUndefined()
  })

  it('never throws on a malformed db', async () => {
    await expect(recordAgentDecision(null, { decision: 'reply' })).resolves.toBeUndefined()
  })

  it('writes meta when provided, null when omitted', async () => {
    const { db, insert } = mockDb()
    const meta = { tools: [{ name: 'verify_identity', input: '{}' }], stop_reason: 'end_turn' }
    await recordAgentDecision(db, { decision: 'reply', meta })
    expect(insert.mock.calls[0][0].meta).toEqual(meta)
    await recordAgentDecision(db, { decision: 'reply' })
    expect(insert.mock.calls[1][0].meta).toBeNull()
  })
})

// Mig 444 — the trace-to-meta compaction.
describe('compactDecisionMeta', () => {
  it('returns null for an empty or model-free trace', () => {
    expect(compactDecisionMeta()).toBeNull()
    expect(compactDecisionMeta({})).toBeNull()
    expect(compactDecisionMeta({ actingContactId: 'c1', tools: [], stopReason: null, iterations: 0 })).toBeNull()
  })

  it('stringifies tool inputs and records stop_reason + iterations', () => {
    const meta = compactDecisionMeta({
      tools: [{ name: 'book_class', input: { event_id: 'e1' } }],
      stopReason: 'end_turn',
      iterations: 2,
    })
    expect(meta).toEqual({
      tools: [{ name: 'book_class', input: '{"event_id":"e1"}' }],
      stop_reason: 'end_turn',
      iterations: 2,
    })
  })

  it('clips oversized inputs and caps the tool list', () => {
    const big = { note: 'x'.repeat(1000) }
    const tools = Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, input: big }))
    const meta = compactDecisionMeta({ tools, stopReason: 'tool_use', iterations: 6 })
    expect(meta.tools).toHaveLength(12)
    expect(meta.tools[0].input.length).toBeLessThanOrEqual(201) // cap + ellipsis
    expect(meta.tools_truncated).toBe(20)
  })

  it('survives an unserialisable input', () => {
    const loop = {}
    loop.self = loop
    const meta = compactDecisionMeta({ tools: [{ name: 'save_lead_details', input: loop }] })
    expect(meta.tools[0].input).toBe('{}')
  })

  // MIA-HYGIENE.4 — a model_error row used to carry meta: null, so the trace
  // said a turn failed but not how. Live example: the 2026-08-12 model_error
  // on WhatsApp, undiagnosable after the fact because the status code and
  // attempt count were only ever in a console line Vercel had since rotated.
  it('records the error kind, status and attempts', () => {
    const meta = compactDecisionMeta({
      error: { kind: 'api_error', status: 529, attempts: 3 },
      iterations: 1,
    })
    expect(meta).toEqual({
      error: { kind: 'api_error', status: 529, attempts: 3 },
      iterations: 1,
    })
  })

  it('clips a long exception message', () => {
    const meta = compactDecisionMeta({
      error: { kind: 'exception', message: 'y'.repeat(400) },
    })
    expect(meta.error.kind).toBe('exception')
    expect(meta.error.message.length).toBeLessThanOrEqual(161) // cap + ellipsis
  })

  it('omits the error key entirely when the turn did not fail', () => {
    const meta = compactDecisionMeta({ stopReason: 'end_turn', iterations: 1 })
    expect(meta).not.toHaveProperty('error')
  })

  it('records an error even when nothing else in the trace is worth keeping', () => {
    expect(compactDecisionMeta({ error: { kind: 'exception', message: 'boom' } }))
      .toEqual({ error: { kind: 'exception', message: 'boom' } })
  })
})
