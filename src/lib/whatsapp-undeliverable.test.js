import { describe, it, expect } from 'vitest'
import { isUndeliverableError, DISPATCHED_STATUSES, UNDELIVERABLE_FAILURE_THRESHOLD } from './whatsapp.js'

describe('isUndeliverableError', () => {
  it('is true for Meta code 131026 (number not a WhatsApp user)', () => {
    expect(isUndeliverableError({ code: 131026 })).toBe(true)
    expect(isUndeliverableError({ code: '131026' })).toBe(true)
  })

  it('is true when the message text says undeliverable (send-time throw carries the title + code)', () => {
    expect(isUndeliverableError({ message: 'Message undeliverable (Meta code 131026)' })).toBe(true)
    expect(isUndeliverableError({ message: 'message Undeliverable' })).toBe(true)
  })

  it('is FALSE for transient / policy failures — these must NOT permanently exclude a contact', () => {
    expect(isUndeliverableError({ code: 131047, message: 'Re-engagement message' })).toBe(false) // 24h window
    expect(isUndeliverableError({ code: 131049, message: 'healthy ecosystem engagement' })).toBe(false) // frequency cap
    expect(isUndeliverableError({ code: 470, message: 'Rate limit hit' })).toBe(false)
    expect(isUndeliverableError({ code: 131000, message: 'Something went wrong' })).toBe(false)
  })

  it('is false for empty / missing input', () => {
    expect(isUndeliverableError()).toBe(false)
    expect(isUndeliverableError({})).toBe(false)
    expect(isUndeliverableError({ code: null, message: null })).toBe(false)
  })
})

describe('UNDELIVERABLE_FAILURE_THRESHOLD', () => {
  it('requires repeated failures (>= 2) before excluding — 131026 is overloaded, a single failure can be transient', () => {
    expect(UNDELIVERABLE_FAILURE_THRESHOLD).toBeGreaterThanOrEqual(2)
  })
})

describe('DISPATCHED_STATUSES', () => {
  it('counts a message as sent through delivered and read (so the tally never shrinks on receipts)', () => {
    expect(DISPATCHED_STATUSES).toEqual(['sent', 'delivered', 'read'])
    expect(DISPATCHED_STATUSES).not.toContain('failed')
  })
})
