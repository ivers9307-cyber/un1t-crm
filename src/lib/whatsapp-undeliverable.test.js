import { describe, it, expect } from 'vitest'
import { isUndeliverableError, DISPATCHED_STATUSES, UNDELIVERABLE_FAILURE_THRESHOLD, shouldPauseAgentForBroadcast } from './whatsapp.js'

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
  it('excludes on the FIRST undeliverable failure (operator policy 2026-06-29; reversible on inbound)', () => {
    expect(UNDELIVERABLE_FAILURE_THRESHOLD).toBe(1)
  })
})

describe('DISPATCHED_STATUSES', () => {
  it('counts a message as sent through delivered and read (so the tally never shrinks on receipts)', () => {
    expect(DISPATCHED_STATUSES).toEqual(['sent', 'delivered', 'read'])
    expect(DISPATCHED_STATUSES).not.toContain('failed')
  })
})

describe('shouldPauseAgentForBroadcast (AGENT-TAKEOVER)', () => {
  it('pauses for a single-recipient send (individual targeted message) regardless of the flag', () => {
    expect(shouldPauseAgentForBroadcast({ handle_replies_manually: false }, 1)).toBe(true)
    expect(shouldPauseAgentForBroadcast({}, 1)).toBe(true)
  })
  it('does NOT pause a bulk send by default (Mia handles the replies at scale)', () => {
    expect(shouldPauseAgentForBroadcast({ handle_replies_manually: false }, 250)).toBe(false)
    expect(shouldPauseAgentForBroadcast({}, 2)).toBe(false)
  })
  it('pauses a bulk send when the operator opted in via handle_replies_manually', () => {
    expect(shouldPauseAgentForBroadcast({ handle_replies_manually: true }, 3000)).toBe(true)
  })
  it('treats a null/absent broadcast defensively', () => {
    expect(shouldPauseAgentForBroadcast(null, 5)).toBe(false)
    expect(shouldPauseAgentForBroadcast(null, 1)).toBe(true)
  })
})
