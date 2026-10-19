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

  it('a failed Hatch approve: the alert reads each code in un1t.online terms (the provider rides on the returned request)', () => {
    for (const code of ['MIA_NO_CREDITS', 'UN1T_ACCOUNT_UNREADABLE', 'NOT_EXECUTABLE_UN1T', 'ACCOUNT_MISMATCH']) {
      const a = approveFailureAlert({
        success: true,
        request: { status: 'failed', details: { provider: 'un1t_online', origin: 'mia' } },
        executed: { ok: false, message_code: code },
      })
      expect(a.title, code).toBe('Approved, but the action failed')
      expect(a.message, code).toMatch(/un1t\.online/)
      expect(a.message, code).not.toMatch(/Glofox|[–—]/)
      expect(a.message, code).not.toContain(code)
    }
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

  // MIAHATCH.5 — Mia's Hatch Street cards run against un1t.online, not Glofox.
  it('a failed Hatch (un1t.online) card reads each code in un1t.online terms, never Glofox', () => {
    const hatch = (result) => ({ status: 'failed', kind: 'class_booking', details: { provider: 'un1t_online', origin: 'mia', result } })
    const expected = {
      MIA_NO_CREDITS: 'No credits show in un1t.online, so nothing was booked. Add credits there, then approve again.',
      UN1T_ACCOUNT_UNREADABLE: "This member's un1t.online account could not be read (a temporary database error), so nothing was sent to un1t.online. Retry.",
      NOT_EXECUTABLE_UN1T: 'This could not be done automatically, so nothing was sent to un1t.online. Do it by hand in un1t.online.',
      ACCOUNT_MISMATCH: 'This was queued for a different un1t.online account than the one the contact holds now, so nothing was sent to un1t.online. Check which account is right in un1t.online, then retry.',
    }
    for (const [code, line] of Object.entries(expected)) {
      const out = failedCardExplanation(hatch({ ok: false, message_code: code }))
      expect(out, code).toBe(line)
      expect(out, code).not.toMatch(/Glofox|[–—]/)
      expect(out, code).not.toContain(code)
    }
  })

  it("another failed Hatch card shows the executor's staff words; a Glofox ACCOUNT_MISMATCH keeps the Glofox line", () => {
    expect(failedCardExplanation({ status: 'failed', details: { provider: 'un1t_online', origin: 'mia', result: { ok: false, code: 'class_unavailable', message: 'This card names no un1t.online class.' } } }))
      .toBe('This card names no un1t.online class.')
    expect(failedCardExplanation({ status: 'failed', details: { result: { ok: false, message_code: 'ACCOUNT_MISMATCH' } } }))
      .toMatch(/different Glofox account/)
  })

  it('anything but a failed card with a result: null (the card shows nothing extra)', () => {
    expect(failedCardExplanation({ status: 'actioned', details: { result: { ok: true } } })).toBeNull()
    expect(failedCardExplanation({ status: 'failed', details: {} })).toBeNull()
    expect(failedCardExplanation(null)).toBeNull()
  })
})
