// EVENT-MOVE.7 — what the decide card says once an event move is decided.
// An event move runs on our own events, never Glofox, so the generic
// "executed in Glofox" line must not show for it.
import { describe, it, expect } from 'vitest'
import { outcomeLine } from './AgentRequestDecideCard'

const item = { kind: 'event_move', conversationId: 'conv-1', details: {} }

describe('outcomeLine — event_move', () => {
  it('actioned with the email sent and a thread', () => {
    const line = outcomeLine('actioned', item, { ok: true, notified: true })
    expect(line.tone).toBe('ok')
    expect(line.text).toBe('Done. The entry is moved and the customer was told in-thread. The new tickets were emailed.')
    expect(line.text).not.toMatch(/Glofox/)
  })
  it('actioned without the email says so', () => {
    const line = outcomeLine('actioned', { ...item, conversationId: null }, { ok: true, notified: false })
    expect(line.text).toBe('Done. The entry is moved. The moved email did NOT go, so send them their tickets.')
  })
  it('failed explains the move refusal, not Glofox', () => {
    const line = outcomeLine('failed', item, { ok: false, move_error: 'wave_full', message: 'That time is full.' })
    expect(line.tone).toBe('bad')
    expect(line.text).toMatch(/^The move did not go through: That time is full\./)
    expect(line.text).not.toMatch(/Glofox/)
  })
})
