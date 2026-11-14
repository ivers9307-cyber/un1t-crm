// APPROVALSQ.2 — the phone's quiet clear: pure helpers (no RN component runner).
import { describe, it, expect } from 'vitest'
import { isCleared, clearWarns, isAlreadyDecided, CLEARED_LABEL, CLEAR_WARNING } from './approval-clear'

describe('isCleared', () => {
  it('true for details.cleared.silent', () => {
    expect(isCleared({ status: 'declined', details: { cleared: { silent: true, from_status: 'pending' } } })).toBe(true)
  })
  it('true for customer_notified.reason cleared', () => {
    expect(isCleared({ status: 'declined', customer_notified: { sent: false, reason: 'cleared' } })).toBe(true)
  })
  it('false for an ordinary decline, empty, or null', () => {
    expect(isCleared({ status: 'declined', details: {} })).toBe(false)
    expect(isCleared({ status: 'declined', details: { cleared: { silent: false } } })).toBe(false)
    expect(isCleared({ customer_notified: { sent: true, reason: 'sent' } })).toBe(false)
    expect(isCleared(null)).toBe(false)
  })
})

describe('clearWarns', () => {
  it('warns for a waiting booking-shaped or consultation request', () => {
    for (const kind of ['class_booking', 'event_booking', 'consultation']) {
      expect(clearWarns({ kind, failed: false })).toBe(true)
    }
  })
  it('not for a failed one, or another kind', () => {
    expect(clearWarns({ kind: 'class_booking', failed: true })).toBe(false)
    expect(clearWarns({ kind: 'cancellation' })).toBe(false)
    expect(clearWarns(null)).toBe(false)
  })
})

describe('isAlreadyDecided', () => {
  it('reads a 409 or the route words', () => {
    expect(isAlreadyDecided({ success: false, status: 409 })).toBe(true)
    expect(isAlreadyDecided({ success: false, error: 'Already decided' })).toBe(true)
    expect(isAlreadyDecided({ success: false, error: 'Network error' })).toBe(false)
    expect(isAlreadyDecided(null)).toBe(false)
  })
})

describe('wording', () => {
  it('uses the fixed copy', () => {
    expect(CLEARED_LABEL).toBe('Cleared, customer not told')
    expect(CLEAR_WARNING).toBe('Mia told this customer the team would confirm. Clearing sends them nothing.')
  })
})
