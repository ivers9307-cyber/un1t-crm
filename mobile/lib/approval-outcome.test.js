// C85 (c) — what the phone says after an approval whose action failed. The
// Approvals screen alerted the raw code (`TRIAL_GRANT_FAILED`) and the
// thread's approval card printed `(TRIAL_GRANT_FAILED)`; both now read the
// operator sentence the web shows (shared/agent-request-failure.js).
import { describe, it, expect } from 'vitest'
import { approveFailureAlert, failedCardExplanation, CLASS_STARTED_MESSAGE } from './approval-outcome'

describe('approveFailureAlert', () => {
  it('nothing to say when the action ran, or nothing was executed', () => {
    expect(approveFailureAlert({ success: true, executed: { ok: true } })).toBeNull()
    expect(approveFailureAlert({ success: true, executed: null })).toBeNull()
    expect(approveFailureAlert({ success: true })).toBeNull()
    expect(approveFailureAlert(null)).toBeNull()
  })

  it('a failed trial grant reads as a sentence with the fix, never the bare code', () => {
    const a = approveFailureAlert({ success: true, request: { status: 'failed' }, executed: { ok: false, message_code: 'TRIAL_GRANT_FAILED', glofox_message_code: 'MEMBERSHIP_NOT_AVAILABLE' } })
    expect(a.title).toBe('Approved, but the action failed')
    expect(a.message).toMatch(/^Glofox would not add the trial credit, so the booking was not attempted\./)
    expect(a.message).toMatch(/Glofox said: MEMBERSHIP_NOT_AVAILABLE\./)
    expect(a.message).toMatch(/The customer has NOT been confirmed\.$/)
    expect(a.message.startsWith('TRIAL_GRANT_FAILED')).toBe(false)
  })

  it('every mapped code: the message is not the code', () => {
    for (const code of ['TRIAL_NOT_CONFIGURED', 'TRIAL_GRANT_UNVERIFIED', 'TRIAL_ALREADY_GRANTED', 'YOU_HAVE_NO_CREDITS_LEFT', 'NOT_EXECUTABLE', 'ACCOUNT_MISMATCH']) {
      const a = approveFailureAlert({ success: true, executed: { ok: false, message_code: code } })
      expect(a.message, code).not.toContain(code)
    }
  })

  it('an unknown Glofox code stays visible inside a sentence', () => {
    expect(approveFailureAlert({ success: true, executed: { ok: false, message_code: 'CLASS_IS_FULL' } }).message)
      .toBe('Glofox rejected the action (CLASS_IS_FULL). Fix the issue in Glofox, then retry. The customer has NOT been confirmed.')
  })

  it('the class had started (the card expired, nothing booked, the member not messaged)', () => {
    const a = approveFailureAlert({ success: true, request: { status: 'expired' }, executed: { ok: false, reason: 'CLASS_ALREADY_STARTED' } })
    expect(a).toEqual({ title: 'Not booked', message: CLASS_STARTED_MESSAGE })
    expect(CLASS_STARTED_MESSAGE).not.toContain('CLASS_ALREADY_STARTED')
  })

  it('no em-dash in anything it says', () => {
    const msgs = [
      approveFailureAlert({ success: true, executed: { ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } }).message,
      approveFailureAlert({ success: true, executed: { ok: false } }).message,
      CLASS_STARTED_MESSAGE,
    ]
    for (const m of msgs) expect(m).not.toContain('—')
  })
})

describe('failedCardExplanation', () => {
  it('a failed card: the sentence, not "(CODE)"', () => {
    const out = failedCardExplanation({ status: 'failed', details: { result: { ok: false, message_code: 'TRIAL_NOT_CONFIGURED' } } })
    expect(out).toMatch(/^No trial membership is set for this studio/)
    expect(out).not.toContain('TRIAL_NOT_CONFIGURED')
  })

  it('anything but a failed card with a result: null (the card shows nothing extra)', () => {
    expect(failedCardExplanation({ status: 'actioned', details: { result: { ok: true } } })).toBeNull()
    expect(failedCardExplanation({ status: 'failed', details: {} })).toBeNull()
    expect(failedCardExplanation(null)).toBeNull()
  })
})
