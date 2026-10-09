// C85 (c) — a failed approval's code, in the operator's words, for the web
// AND the phone. failureExplanation lived in src/lib/approvals/
// agent-request-why.js, which the phone cannot import, so the phone's
// post-approve alert printed the raw code (`TRIAL_GRANT_FAILED`). It now
// lives here and the web module re-exports it: one definition.
import { describe, it, expect } from 'vitest'
import { failureExplanation, FAILURE_CODES } from './agent-request-failure'

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

// EVENT-MOVE.7 — a refused event move carries the move's own code and its
// plain message, never a Glofox code.
describe('failureExplanation — event move', () => {
  it('explains the refusal in the move\'s words and says how to fix it', () => {
    const line = failureExplanation({ status: 'failed', details: { result: { ok: false, move_error: 'wave_full', message: 'That time is full.' } } })
    expect(line).toMatch(/^The move did not go through: That time is full\./)
    expect(line).toMatch(/retry/i)
    expect(line).not.toMatch(/Glofox/)
  })
  it('falls back to the code when there is no message', () => {
    expect(failureExplanation({ status: 'failed', details: { result: { ok: false, move_error: 'conflict' } } }))
      .toMatch(/^The move did not go through \(conflict\)\./)
  })
})
