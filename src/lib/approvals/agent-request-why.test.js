import { describe, it, expect, vi } from 'vitest'
import { whyFlagged, customerWords, approvalGrantsTrialCredit } from './agent-request-why'

describe('whyFlagged', () => {
  it('translates every routeToReview machine code for class bookings', () => {
    for (const code of ['prior_attendance', 'needs_credit_grant', 'no_credits', 'account_ambiguous', 'account_conflict', 'account_failed', 'attendance_check_failed', 'credit_check_failed', 'booking_rejected', 'superseded_duplicate']) {
      const out = whyFlagged({ kind: 'class_booking', details: { reason: code } })
      expect(out, code).toBeTruthy()
      // Operator copy, never the raw snake_case code on its own.
      expect(out).not.toBe(code)
    }
  })

  it('explains booking_failed:<code> with the Glofox code kept visible', () => {
    expect(whyFlagged({ kind: 'class_booking', details: { reason: 'booking_failed:CLASS_IS_FULL' } }))
      .toContain('CLASS_IS_FULL')
  })

  it('has plain-English copy for the no-credits Glofox code', () => {
    const out = whyFlagged({ kind: 'class_booking', details: { reason: 'booking_failed:YOU_HAVE_NO_CREDITS_LEFT' } })
    expect(out).toMatch(/no class credits/i)
  })

  // PERSON-ACCT.7 — account_conflict must NOT fall through to the generic
  // account_<status> prefix line: Mia found two live accounts and refused to
  // guess, which is a different instruction to the operator.
  it('account_conflict gets its own copy, not the account_ prefix fallback', () => {
    const out = whyFlagged({ kind: 'class_booking', details: { reason: 'account_conflict' } })
    expect(out).toMatch(/more than one account/i)
    expect(out).not.toContain('account_conflict')
  })

  it('covers the account_<status> family via the prefix fallback', () => {
    expect(whyFlagged({ kind: 'class_booking', details: { reason: 'account_skipped' } }))
      .toContain('account_skipped')
  })

  it('surfaces an unknown machine code raw rather than hiding it', () => {
    expect(whyFlagged({ kind: 'class_booking', details: { reason: 'brand_new_code' } }))
      .toContain('brand_new_code')
  })

  it('explains draft-mode bookings that carry no reason', () => {
    expect(whyFlagged({ kind: 'class_booking', details: { mode: 'draft' } })).toMatch(/draft/i)
  })

  it('returns null for pause/cancellation — their reason is the customer talking', () => {
    expect(whyFlagged({ kind: 'pause', details: { reason: 'travelling for work' } })).toBeNull()
    expect(whyFlagged({ kind: 'cancellation', details: { reason: 'moving away' } })).toBeNull()
    expect(whyFlagged(null)).toBeNull()
  })
})

describe('customerWords', () => {
  it('prefers the explicit customer note (both spellings)', () => {
    expect(customerWords({ kind: 'pause', customer_note: 'back in March', details: { reason: 'x' } })).toBe('back in March')
    expect(customerWords({ kind: 'pause', customerNote: 'back in March' })).toBe('back in March')
  })

  it('falls back to details.reason for pause/cancellation', () => {
    expect(customerWords({ kind: 'cancellation', details: { reason: 'moving away' } })).toBe('moving away')
  })

  it('never surfaces a class_booking machine code as customer words', () => {
    expect(customerWords({ kind: 'class_booking', details: { reason: 'prior_attendance' } })).toBeNull()
  })

  it('handles empty rows', () => {
    expect(customerWords(null)).toBeNull()
    expect(customerWords({ kind: 'pause', details: {} })).toBeNull()
  })
})

// AGENT-RETRY.1 — failed-execution copy for the Fix & retry surfaces.
import { failureExplanation } from './agent-request-why'

describe('failureExplanation', () => {
  it('explains the no-credits Glofox rejection with a fix instruction', () => {
    const out = failureExplanation({ status: 'failed', details: { result: { ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } } })
    expect(out).toMatch(/grant a credit/i)
  })
  it('explains NOT_EXECUTABLE (no linked account / no config)', () => {
    expect(failureExplanation({ status: 'failed', details: { result: { message_code: 'NOT_EXECUTABLE' } } }))
      .toMatch(/linked/i)
  })
  it('keeps an unknown code visible', () => {
    // PERSON-ACCT.7 — the executor refused because the row's elected account
    // no longer matches the contact's link.
    expect(failureExplanation({ status: 'failed', details: { result: { message_code: 'ACCOUNT_MISMATCH' } } }))
      .toMatch(/account/i)
    expect(failureExplanation({ status: 'failed', details: { result: { message_code: 'ACCOUNT_MISMATCH' } } }))
      .not.toContain('ACCOUNT_MISMATCH')

    expect(failureExplanation({ status: 'failed', details: { result: { message_code: 'CLASS_IS_FULL' } } }))
      .toContain('CLASS_IS_FULL')
  })
  it('handles a failed row with no result payload', () => {
    expect(failureExplanation({ status: 'failed', details: {} })).toMatch(/retry/i)
  })
  it('returns null for anything not failed', () => {
    expect(failureExplanation({ status: 'actioned', details: { result: { ok: true } } })).toBeNull()
    expect(failureExplanation(null)).toBeNull()
  })

  it('REGISTRYREAD.1a: GLOFOX_SETTINGS_UNREADABLE says the settings could not be read and to retry', () => {
    const out = failureExplanation({ status: 'failed', details: { result: { ok: false, message_code: 'GLOFOX_SETTINGS_UNREADABLE' } } })
    expect(out).toMatch(/could not be read/)
    expect(out).toMatch(/Retry/)
    expect(out).not.toMatch(/Glofox rejected/)
  })
})

// AGENT-FUNNEL-CREDITS.1 — the account summary line on approval cards.
import { accountSummaryLine } from './agent-request-why'

describe('accountSummaryLine', () => {
  it('renders plan + credits (the approve-with-confidence case)', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'The UN1T Trial', glofox_membership_status: 'trial', glofox_membership_state: 'future', trial_credits_remaining: 3 }))
      .toBe('The UN1T Trial (trial, not started) · 3 credits left')
  })
  // PERSON-ACCT.3 — glofox_membership_status is NEVER the string 'active' in
  // prod; a genuinely bookable membership is status 'member'/'credit_member'
  // with state 'active' (or null).
  it('a bookable membership (member + active state) renders without a qualifier', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'UN1T Unlimited', glofox_membership_status: 'member', glofox_membership_state: 'active', trial_credits_remaining: null }))
      .toBe('UN1T Unlimited · credits unknown')
  })
  // PERSON-ACCT.3 — the state, not the status, is what says this account
  // cannot book right now; the OLD `status !== 'active'` check (always true,
  // since that string never occurs) meant a paused/locked member rendered as
  // if nothing were wrong. These two prove the state now surfaces.
  it('a paused membership surfaces BOTH the status and the blocking state', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'UN1T Unlimited', glofox_membership_status: 'member', glofox_membership_state: 'paused', trial_credits_remaining: null }))
      .toBe('UN1T Unlimited (member, paused) · credits unknown')
  })
  it('a locked membership (in arrears) surfaces the same way', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'UN1T Unlimited', glofox_membership_status: 'credit_member', glofox_membership_state: 'locked', trial_credits_remaining: null }))
      .toBe('UN1T Unlimited (credit_member, locked) · credits unknown')
  })
  it('an ACTIVE-state trial is still just "(trial)" — active state alone never clears the qualifier', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'The UN1T Trial', glofox_membership_status: 'trial', glofox_membership_state: 'active', trial_credits_remaining: 2 }))
      .toBe('The UN1T Trial (trial) · 2 credits left')
  })
  it('an ACTIVE-state classpass_payg account is "(classpass_payg)" — never mistaken for a real membership', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'ClassPass', glofox_membership_status: 'classpass_payg', glofox_membership_state: 'active', trial_credits_remaining: null }))
      .toBe('ClassPass (classpass_payg) · credits unknown')
  })
  it('no membership + zero credits (the grant-first case)', () => {
    expect(accountSummaryLine({ glofox_membership_plan: null, trial_credits_remaining: 0 }))
      .toBe('No membership on file · 0 credits left')
  })
  it('singular credit', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'Pack', glofox_membership_status: 'member', glofox_membership_state: 'active', trial_credits_remaining: 1 }))
      .toBe('Pack · 1 credit left')
  })
  it('null contact → null', () => {
    expect(accountSummaryLine(null)).toBeNull()
  })
})

// CBPCREDITREAD.1 — approving needs_credit_grant BUYS the trial membership
// before booking (membership-requests/[id]/route.js). That must rest on a
// read that worked; credit_check_failed is an UNKNOWN balance and buys nothing.
describe('approvalGrantsTrialCredit', () => {
  it('is true only for needs_credit_grant', () => {
    expect(approvalGrantsTrialCredit({ reason: 'needs_credit_grant' })).toBe(true)
  })
  it('is false for an unread balance and every other reason', () => {
    for (const reason of ['credit_check_failed', 'prior_attendance', 'processing_error', 'no_credits', 'booking_failed:YOU_HAVE_NO_CREDITS_LEFT', undefined]) {
      expect(approvalGrantsTrialCredit({ reason }), String(reason)).toBe(false)
    }
    expect(approvalGrantsTrialCredit(null)).toBe(false)
  })
})

describe('credit_check_failed copy', () => {
  it('says the balance is unknown and that approving adds nothing', () => {
    const out = whyFlagged({ kind: 'class_booking', details: { reason: 'credit_check_failed' } })
    expect(out).toMatch(/does not mean they have no credits/i)
    expect(out).toMatch(/approving does not add a credit/i)
  })
})

// CBPCREDITREAD.1 review — the card says WHICH account could not be read:
// the one the booking was for, or another account linked to the same person.
// Identified by the Glofox member ID only (no name, email or phone).
describe('credit_check_failed names the unreadable account', () => {
  const why = (accounts) => whyFlagged({ kind: 'class_booking', details: { reason: 'credit_check_failed', credit_unread_accounts: accounts } })

  it('the account the booking was for', () => {
    const out = why([{ role: 'booking_account', contact_id: 'c-1', glofox_member_id: 'gm-aaa' }])
    expect(out).toMatch(/the Glofox account this booking was for \(member ID gm-aaa\)/)
    expect(out).not.toMatch(/linked to this person/)
  })

  it('another account linked to the same person', () => {
    const out = why([{ role: 'linked_account', contact_id: 'c-2', glofox_member_id: 'gm-bbb' }])
    expect(out).toMatch(/another Glofox account linked to this person \(member ID gm-bbb\)/)
    expect(out).not.toMatch(/this booking was for/)
  })

  it('keeps the three pinned phrases, and the plain copy when no account is named', () => {
    const named = why([{ role: 'booking_account', glofox_member_id: 'gm-aaa' }, { role: 'linked_account', glofox_member_id: 'gm-bbb' }])
    const plain = why(undefined)
    for (const out of [named, plain]) {
      expect(out).toMatch(/could not be read/i)
      expect(out).toMatch(/does not mean they have no credits/i)
      expect(out).toMatch(/approving does not add a credit/i)
    }
    expect(named).toMatch(/gm-aaa/)
    expect(named).toMatch(/gm-bbb/)
    expect(plain).not.toMatch(/member ID/)
  })

  it('ignores a malformed list rather than rendering it', () => {
    expect(why('gm-aaa')).toBe(why(undefined))
    expect(why([{ role: 'booking_account' }, null])).toBe(why(undefined))
  })
})

// CBPCREDITREAD.1 review — the retry count in the card copy follows the
// queue's attempt cap (one constant, class-booking-attempts.js), so the copy
// can never say "3 tries" after the cap moves.
describe('the retry count in the copy follows the attempt cap', () => {
  it('says the cap it was built with', async () => {
    vi.resetModules()
    vi.doMock('@/lib/class-booking-attempts', () => ({ CLASS_BOOKING_MAX_ATTEMPTS: 5 }))
    try {
      const { whyFlagged: why } = await import('./agent-request-why')
      const copy = (reason) => why({ kind: 'class_booking', details: { reason } })
      expect(copy('credit_check_failed')).toMatch(/after 5 tries/)
      expect(copy('processing_error')).toMatch(/failed 5 times/)
      expect(copy('max_attempts_stuck_processing')).toMatch(/interrupted 5 times/)
    } finally {
      vi.doUnmock('@/lib/class-booking-attempts')
      vi.resetModules()
    }
  })
})

// TRIALGRANT.1 — the approve path's trial grant is judged; a grant that did
// not happen lands the card on 'failed' with one of these codes, and nothing
// was booked.
describe('failureExplanation: the trial grant (TRIALGRANT.1)', () => {
  const failed = (result) => failureExplanation({ status: 'failed', details: { result } })

  it('TRIAL_GRANT_FAILED says nothing was booked, keeps Glofox’s code visible, and says a retry will not stack a trial', () => {
    const out = failed({ ok: false, message_code: 'TRIAL_GRANT_FAILED', glofox_message_code: 'PURCHASE_NOT_ALLOWED' })
    expect(out).toMatch(/would not add the trial/i)
    expect(out).toMatch(/not attempted/i)
    expect(out).toContain('PURCHASE_NOT_ALLOWED')
    expect(out).toMatch(/does not add another trial/i)
  })

  it('TRIAL_GRANT_FAILED without a Glofox code still reads cleanly', () => {
    expect(failed({ ok: false, message_code: 'TRIAL_GRANT_FAILED', glofox_message_code: null })).not.toMatch(/Glofox said/)
  })

  it('TRIAL_NOT_CONFIGURED and TRIAL_GRANT_UNVERIFIED have their own copy', () => {
    expect(failed({ ok: false, message_code: 'TRIAL_NOT_CONFIGURED' })).toMatch(/no trial membership is set/i)
    expect(failed({ ok: false, message_code: 'TRIAL_GRANT_UNVERIFIED' })).toMatch(/no second trial/i)
  })

  it('no-credits AFTER a trial was added says so (the trial may start later); a skipped or absent grant keeps the plain copy', () => {
    expect(failed({ ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT', trial_grant: { ok: true, invoice_id: 'inv-1' } })).toMatch(/trial was added/i)
    expect(failed({ ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT', trial_grant: { ok: true, skipped: 'credits_present' } })).toMatch(/grant a credit/i)
    expect(failed({ ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' })).toMatch(/grant a credit/i)
  })

  it('needs_credit_grant card copy no longer promises the booking completes', () => {
    const out = whyFlagged({ kind: 'class_booking', details: { reason: 'needs_credit_grant' } })
    expect(out).toMatch(/adds the trial in Glofox first/i)
    expect(out).not.toMatch(/completes the booking automatically/i)
  })
})

// Review of TRIALGRANT.1 — the write-ahead grant record adds a code, and an
// unfinished or unanswered purchase is a DOUBT, not a refusal: staff check
// Glofox for the trial's €0 invoice rather than buy blind.
describe('failureExplanation: the write-ahead trial grant (TRIALGRANT.1 review)', () => {
  const failed = (result) => failureExplanation({ status: 'failed', details: { result } })

  it('TRIAL_GRANT_UNRECORDED says nothing was bought or booked, and to retry', () => {
    const out = failed({ ok: false, message_code: 'TRIAL_GRANT_UNRECORDED' })
    expect(out).toMatch(/no trial was bought/i)
    expect(out).toMatch(/nothing was booked/i)
    expect(out).toMatch(/retry/i)
  })

  it('TRIAL_GRANT_UNVERIFIED points staff at the €0 trial invoice, and still promises no second trial', () => {
    const out = failed({ ok: false, message_code: 'TRIAL_GRANT_UNVERIFIED', outcome_unknown: true })
    expect(out).toMatch(/€0 trial invoice/)
    expect(out).toMatch(/no second trial/i)
  })

  it('a purchase Glofox never answered is not "Glofox would not add the trial"', () => {
    const out = failed({ ok: false, message_code: 'TRIAL_GRANT_FAILED', http_status: 0, outcome_unknown: true })
    expect(out).toMatch(/did not answer/i)
    expect(out).toMatch(/€0 trial invoice/)
    expect(out).not.toMatch(/would not add the trial/i)
  })

  it('a pending needs_credit_grant card stamped unsettled at the mint says approving will not buy a second trial', () => {
    const out = whyFlagged({ kind: 'class_booking', details: { reason: 'needs_credit_grant', trial_grant: { ok: false, code: 'TRIAL_GRANT_FAILED', outcome_unknown: true } } })
    expect(out).toMatch(/no clear answer/i)
    expect(out).toMatch(/€0 trial invoice/)
    expect(out).toMatch(/not buy a second trial/i)
    expect(out).not.toMatch(/Approving adds the trial/)
  })

  it('a purchase that answered 5xx reads as no clear answer, not "would not add" (GLOFOXPOSTRETRY.1)', () => {
    const out = failed({ ok: false, message_code: 'TRIAL_GRANT_FAILED', http_status: 503, outcome_unknown: true })
    expect(out).toMatch(/server error/i)
    expect(out).toMatch(/€0 trial invoice/)
    expect(out).not.toMatch(/would not add the trial/i)
  })
})
