import { describe, it, expect } from 'vitest'
import { deriveOutcome, outcomeAt, OUTCOMES, FAILURE_COPY, failureCopy } from './host-campaign-outcome.js'

const base = { status: 'sent', sent_at: '2026-09-04T10:58:14Z', delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null, failed_reason: null }

describe('deriveOutcome — precedence', () => {
  it('queued for pending/claimed', () => {
    expect(deriveOutcome({ ...base, status: 'pending' })).toBe('queued')
    expect(deriveOutcome({ ...base, status: 'claimed' })).toBe('queued')
  })
  it('failed beats everything', () => expect(deriveOutcome({ ...base, status: 'failed', opened_at: 'x', failed_reason: 'send_error' })).toBe('failed'))
  it('bounced > complained > unsubscribed > clicked > opened > delivered > sent', () => {
    expect(deriveOutcome({ ...base, bounced_at: 'x', complained_at: 'x', clicked_at: 'x' })).toBe('bounced')
    expect(deriveOutcome({ ...base, complained_at: 'x', unsubscribed_at: 'x', clicked_at: 'x' })).toBe('complained')
    expect(deriveOutcome({ ...base, unsubscribed_at: 'x', clicked_at: 'x' })).toBe('unsubscribed')
    expect(deriveOutcome({ ...base, clicked_at: 'x', opened_at: 'x', delivered_at: 'x' })).toBe('clicked')
    expect(deriveOutcome({ ...base, opened_at: 'x', delivered_at: 'x' })).toBe('opened')
    expect(deriveOutcome({ ...base, delivered_at: 'x' })).toBe('delivered')
    expect(deriveOutcome(base)).toBe('sent')
  })
  it('a late Delivery after an Open still reads opened', () => expect(deriveOutcome({ ...base, opened_at: '2026-09-04T11:00:00Z', delivered_at: '2026-09-04T11:05:00Z' })).toBe('opened'))
  it('null row → queued', () => expect(deriveOutcome(null)).toBe('queued'))
})

describe('outcomeAt — the timestamp the outcome is about', () => {
  it('returns the matching column', () => {
    expect(outcomeAt({ ...base, opened_at: 'o', delivered_at: 'd' })).toBe('o')
    expect(outcomeAt({ ...base, status: 'failed', claimed_at: 'c' })).toBe('c')
    expect(outcomeAt({ ...base, status: 'pending' })).toBeNull()
    expect(outcomeAt(base)).toBe(base.sent_at)
  })
})

describe('failure copy', () => {
  it('every stamped reason has customer-tone copy with no em-dash', () => {
    for (const r of ['no_host_consent', 'host_unsubscribed', 'mailbox_blocked', 'no_email', 'send_error', 'stale_claim', 'no_administrative_consent']) {
      expect(FAILURE_COPY[r]).toBeTruthy()
      expect(FAILURE_COPY[r]).not.toMatch(/—/)
    }
  })
  it('unknown reason falls back', () => expect(failureCopy('wat')).toBe('Could not be sent'))
  it('OUTCOMES lists the nine outcomes in display order', () => {
    expect(OUTCOMES).toEqual(['failed', 'bounced', 'complained', 'unsubscribed', 'clicked', 'opened', 'delivered', 'sent', 'queued'])
  })
})
