import { describe, it, expect } from 'vitest'
import { shouldSendSmsConfirmation } from './race-confirmations'

// EVENTS-SMS-TOGGLE — the race-registration SMS confirmation is opt-in
// per event (race_events.confirmation_sms_enabled, default false). This
// pins the send-gate decision so an accidental loosening — texting people
// for an event that never opted in — is caught. The email confirmation is
// a SEPARATE path and unaffected by this flag.
describe('shouldSendSmsConfirmation', () => {
  it('does NOT send when the event has SMS confirmations disabled', () => {
    const r = shouldSendSmsConfirmation({ confirmation_sms_enabled: false }, { confirmation_sms_sent_at: null })
    expect(r.send).toBe(false)
    expect(r.reason).toBe('disabled_for_event')
  })

  it('does NOT send when the flag is absent (default off — behaviour for every legacy event)', () => {
    const r = shouldSendSmsConfirmation({}, { confirmation_sms_sent_at: null })
    expect(r.send).toBe(false)
    expect(r.reason).toBe('disabled_for_event')
  })

  it('does NOT send when the race is missing entirely (never text on a broken load)', () => {
    const r = shouldSendSmsConfirmation(null, { confirmation_sms_sent_at: null })
    expect(r.send).toBe(false)
    expect(r.reason).toBe('disabled_for_event')
  })

  it('sends when enabled and not yet sent', () => {
    const r = shouldSendSmsConfirmation({ confirmation_sms_enabled: true }, { confirmation_sms_sent_at: null })
    expect(r.send).toBe(true)
  })

  it('skips as already_sent when enabled but the receipt was already texted', () => {
    const r = shouldSendSmsConfirmation(
      { confirmation_sms_enabled: true },
      { confirmation_sms_sent_at: '2026-08-18T09:00:00.000Z' },
    )
    expect(r.send).toBe(false)
    expect(r.reason).toBe('already_sent')
  })
})
