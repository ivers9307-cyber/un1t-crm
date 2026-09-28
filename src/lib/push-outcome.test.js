// C21 PUSHDONE.1 — the one reading of a push result that every "record it
// done" caller uses. Only 'failed' may be retried; 'delivered' must never be.
import { describe, it, expect } from 'vitest'
import { pushOutcome } from './push-outcome'

describe('pushOutcome', () => {
  it('a throw (no result) is failed', () => {
    expect(pushOutcome(null)).toBe('failed')
    expect(pushOutcome(undefined)).toBe('failed')
  })

  it('anything delivered is delivered, even beside failures (a partial send must never repeat)', () => {
    expect(pushOutcome({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })).toBe('delivered')
    expect(pushOutcome({ sent: 1, failed: 3, read_failed: 1 })).toBe('delivered')
    expect(pushOutcome({ sent: 0, failed: 1, emailed: 1, email_failed: 0 })).toBe('delivered')
  })

  it('nothing delivered and something broke is failed', () => {
    expect(pushOutcome({ sent: 0, skipped: 0, invalidated: 0, failed: 2 })).toBe('failed')
    expect(pushOutcome({ sent: 0, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 })).toBe('failed')
    // C1: a failed role read claims nothing and reports failed: 0 beside the flag.
    expect(pushOutcome({ sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 })).toBe('failed')
    expect(pushOutcome({ sent: 0, skipped: 0, failed: 0, emailed: 0, email_failed: 1 })).toBe('failed')
  })

  it('nothing delivered and nothing broke is settled (opt-out, no device, nobody holds the role, deduped)', () => {
    expect(pushOutcome({ sent: 0, skipped: 2, invalidated: 0, failed: 0 })).toBe('settled')
    expect(pushOutcome({ sent: 0, invalidated: 0, failed: 0, skipped: 0 })).toBe('settled')
    expect(pushOutcome({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 2 })).toBe('settled')
    expect(pushOutcome({ sent: 0, skipped: 0, invalidated: 1, failed: 0 })).toBe('settled')
  })
})
