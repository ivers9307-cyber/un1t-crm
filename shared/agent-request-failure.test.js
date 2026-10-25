// C85 (c) — a failed approval's code, in the operator's words, for the web
// AND the phone. failureExplanation lived in src/lib/approvals/
// agent-request-why.js, which the phone cannot import, so the phone's
// post-approve alert printed the raw code (`TRIAL_GRANT_FAILED`). It now
// lives here and the web module re-exports it: one definition.
import { describe, it, expect } from 'vitest'
import { failureExplanation, FAILURE_CODES, un1tFailureExplanation, UN1T_FAILURE_CODES } from './agent-request-failure'

const failed = (result) => failureExplanation({ status: 'failed', details: { result } })

describe('failureExplanation (shared)', () => {
  it('every code the approve route writes reads as a sentence, never the bare code', () => {
    // src/app/api/agent/membership-requests/[id]/route.js and
    // src/lib/agent/trial-grant.js
    const codes = [
      'YOU_HAVE_NO_CREDITS_LEFT', 'NOT_EXECUTABLE', 'ACCOUNT_MISMATCH', 'NO_END_DATE', 'NO_USER_MEMBERSHIP',
      'GLOFOX_SETTINGS_UNREADABLE', 'TRIAL_GRANT_FAILED', 'TRIAL_NOT_CONFIGURED', 'TRIAL_GRANT_UNVERIFIED',
      'TRIAL_GRANT_UNRECORDED', 'TRIAL_ALREADY_GRANTED', 'TRIAL_HISTORY_UNREADABLE', 'TRIAL_PRODUCT_UNKNOWN',
    ]
    for (const code of codes) {
      expect(FAILURE_CODES).toContain(code)
      const out = failed({ ok: false, message_code: code })
      expect(out, code).toMatch(/^[A-Z].{40,}\.$/)
      expect(out, code).not.toContain(code)
      // Staff copy on the phone and the web: plain punctuation, no em-dash.
      expect(out, code).not.toContain('\u2014')
    }
  })

  it('TRIAL_GRANT_FAILED names what Glofox said, and the no-answer case says so', () => {
    expect(failed({ ok: false, message_code: 'TRIAL_GRANT_FAILED', glofox_message_code: 'MEMBERSHIP_NOT_AVAILABLE' }))
      .toMatch(/Glofox would not add the trial credit.*Glofox said: MEMBERSHIP_NOT_AVAILABLE\.$/)
    expect(failed({ ok: false, message_code: 'TRIAL_GRANT_FAILED', outcome_unknown: true }))
      .toMatch(/^Glofox did not answer clearly/)
  })

  it('an unknown Glofox code keeps the code visible, inside a sentence', () => {
    expect(failed({ ok: false, message_code: 'CLASS_IS_FULL' })).toBe('Glofox rejected the action (CLASS_IS_FULL). Fix the issue in Glofox, then retry.')
  })

  it('no code at all: a generic fix-then-retry line; not a failed row: null', () => {
    expect(failed({ ok: false })).toMatch(/retry/)
    expect(failureExplanation({ status: 'actioned', details: { result: { ok: true } } })).toBeNull()
    expect(failureExplanation(null)).toBeNull()
  })
})

// MIAHATCH.5 — Mia's Hatch Street cards (details.provider 'un1t_online') run
// against un1t.online; the phone read their codes as "Glofox rejected the
// action (CODE)" until this wording moved here from the web.
describe('failureExplanation: a failed un1t.online card (shared)', () => {
  const hatch = (result) => failureExplanation({ status: 'failed', details: { provider: 'un1t_online', origin: 'mia', result } })

  it('every un1t code, and ACCOUNT_MISMATCH on a un1t card, reads in un1t.online terms', () => {
    expect(UN1T_FAILURE_CODES).toEqual(['MIA_NO_CREDITS', 'UN1T_ACCOUNT_UNREADABLE', 'NOT_EXECUTABLE_UN1T'])
    for (const code of [...UN1T_FAILURE_CODES, 'ACCOUNT_MISMATCH']) {
      const out = hatch({ ok: false, message_code: code })
      expect(out, code).toMatch(/^[A-Z].{40,}\.$/)
      expect(out, code).toMatch(/un1t\.online/)
      expect(out, code).not.toMatch(/Glofox|[\u2013\u2014]/)
      expect(out, code).not.toContain(code)
      expect(out, code).toBe(un1tFailureExplanation({ status: 'failed', details: { provider: 'un1t_online', origin: 'mia', result: { message_code: code } } }))
    }
  })

  it('the un1t-only codes read the same with only a result (a post-approve outcome); ACCOUNT_MISMATCH then stays Glofox', () => {
    expect(failed({ ok: false, message_code: 'MIA_NO_CREDITS' })).toMatch(/^No credits show in un1t\.online/)
    expect(failed({ ok: false, message_code: 'ACCOUNT_MISMATCH' })).toMatch(/different Glofox account/)
    expect(un1tFailureExplanation({ status: 'failed', details: { result: { message_code: 'ACCOUNT_MISMATCH' } } })).toBeNull()
  })

  it("another failed Mia card shows the executor's staff words; with none, the generic line", () => {
    expect(hatch({ ok: false, code: 'class_unavailable', message: '  This card names no un1t.online class. ' })).toBe('This card names no un1t.online class.')
    expect(un1tFailureExplanation({ status: 'actioned', details: { provider: 'un1t_online', origin: 'mia', result: { message_code: 'MIA_NO_CREDITS' } } })).toBeNull()
    expect(un1tFailureExplanation(null)).toBeNull()
  })
})
