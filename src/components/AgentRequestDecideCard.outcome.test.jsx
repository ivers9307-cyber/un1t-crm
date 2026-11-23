// EVENT-MOVE.7 — what the decide card says once an event move is decided.
// An event move runs on our own events, never Glofox, so the generic
// "executed in Glofox" line must not show for it.
import { describe, it, expect } from 'vitest'
import { outcomeLine, isWebsiteRequest } from './AgentRequestDecideCard'

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

// UN1TWRITE.8 — a refund card is record-only: the line must not claim Glofox
// or a customer message.
describe('outcomeLine — refund_request', () => {
  const item = { kind: 'refund_request', conversationId: 'conv1' }

  it('actioned says the refund is done by hand in un1t.online, not "executed in Glofox"', () => {
    const line = outcomeLine('actioned', item, { ok: true, record_only: true })
    expect(line).toEqual({ tone: 'ok', text: 'Recorded. The refund itself is done by hand in the un1t.online owner console.' })
    expect(line.text).not.toMatch(/glofox/i)
  })

  it('declined says the customer was not messaged', () => {
    const line = outcomeLine('declined', item, null)
    expect(line.text).toMatch(/not messaged/)
    expect(line.text).not.toMatch(/—/)
  })
})

// APPROVALSQ.1 — a quiet clear.
describe('outcomeLine — cleared', () => {
  it('says cleared and not told for a silent decline', () => {
    const line = outcomeLine('declined', { kind: 'refund_request', conversationId: 'c' }, null, { sent: false, channel: null, reason: 'cleared' })
    expect(line).toEqual({ tone: 'neutral', text: 'Cleared. The customer was not told.' })
  })
})

// CARDHATCH.1 — a un1t.online card runs on un1t.online, never Glofox.
describe('outcomeLine — a un1t.online booking card', () => {
  const un1t = { kind: 'class_booking', conversationId: null, details: { provider: 'un1t_online', reason: 'un1t_booking_failed:CLASS_FULL' } }
  it('booked by the approval names un1t.online', () => {
    const line = outcomeLine('actioned', un1t, { ok: true })
    expect(line.tone).toBe('ok')
    expect(line.text).toBe('Done. Booked in un1t.online.')
  })
  it('with a thread, says the customer was told there', () => {
    expect(outcomeLine('actioned', { ...un1t, conversationId: 'c1' }, { ok: true }).text).toBe('Done. Booked in un1t.online and the customer was told in-thread.')
  })
  it('a record-only approval claims no booking', () => {
    const line = outcomeLine('actioned', un1t, { ok: true, record_only: true })
    expect(line.text).toBe('Recorded as booked. Nothing was sent to un1t.online.')
  })
  it('a cancellation names un1t.online', () => {
    const line = outcomeLine('actioned', { kind: 'class_cancellation', conversationId: null, details: { provider: 'un1t_online' } }, { ok: true })
    expect(line.text).toBe('Done. Cancelled in un1t.online.')
    expect(line.text).not.toMatch(/Glofox/)
  })
})

describe('isWebsiteRequest', () => {
  it('a public-page booking is the website\'s, not Mia\'s', () => {
    expect(isWebsiteRequest({ details: { source: 'start_funnel' } })).toBe(true)
  })
  it("Mia's own card and a card with no source stay Mia's", () => {
    expect(isWebsiteRequest({ details: { source: 'start_funnel', origin: 'mia' } })).toBe(false)
    expect(isWebsiteRequest({ details: {} })).toBe(false)
    expect(isWebsiteRequest({})).toBe(false)
  })
})
