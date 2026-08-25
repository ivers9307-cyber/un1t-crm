import { describe, it, expect } from 'vitest'
import { whyFlagged, customerWords } from './agent-request-why'

describe('whyFlagged', () => {
  it('translates every routeToReview machine code for class bookings', () => {
    for (const code of ['prior_attendance', 'needs_credit_grant', 'account_ambiguous', 'account_failed', 'attendance_check_failed', 'booking_rejected', 'superseded_duplicate']) {
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
})

// AGENT-FUNNEL-CREDITS.1 — the account summary line on approval cards.
import { accountSummaryLine } from './agent-request-why'

describe('accountSummaryLine', () => {
  it('renders plan + credits (the approve-with-confidence case)', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'The UN1T Trial', glofox_membership_status: 'trial', glofox_membership_state: 'future', trial_credits_remaining: 3 }))
      .toBe('The UN1T Trial (trial, not started) · 3 credits left')
  })
  it('active membership renders without a qualifier', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'UN1T Unlimited', glofox_membership_status: 'active', glofox_membership_state: 'active', trial_credits_remaining: null }))
      .toBe('UN1T Unlimited · credits unknown')
  })
  it('no membership + zero credits (the grant-first case)', () => {
    expect(accountSummaryLine({ glofox_membership_plan: null, trial_credits_remaining: 0 }))
      .toBe('No membership on file · 0 credits left')
  })
  it('singular credit', () => {
    expect(accountSummaryLine({ glofox_membership_plan: 'Pack', glofox_membership_status: 'active', trial_credits_remaining: 1 }))
      .toBe('Pack · 1 credit left')
  })
  it('null contact → null', () => {
    expect(accountSummaryLine(null)).toBeNull()
  })
})
