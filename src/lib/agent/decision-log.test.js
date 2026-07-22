import { describe, it, expect, vi } from 'vitest'
import { recordAgentDecision } from './decision-log.js'

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
})
