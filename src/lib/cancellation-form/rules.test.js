// CANCEL-FORM.3 — pure submission rules for the public form. Dates are
// Dublin business days (YYYY-MM-DD strings, never Date-at-midnight maths),
// so this file must pass under any TZ: run it under Europe/Dublin AND a US
// zone before trusting a change (LESSONS).

import { describe, it, expect } from 'vitest'
import { CANCELLATION_FORM_DEFAULTS } from './defaults.js'
import { formOptions, validateSubmission, SubmitSchema } from './rules.js'

const TODAY = '2026-09-05'
const copy = { ...CANCELLATION_FORM_DEFAULTS }

describe('formOptions', () => {
  it('derives the member-facing bounds from the copy block and today', () => {
    const o = formOptions({ ...copy, notice_days: 30, pause_max_weeks: 4 }, TODAY)
    expect(o.today).toBe(TODAY)
    expect(o.min_end_date).toBe('2026-10-05')
    expect(o.max_end_date).toBe('2027-03-04')
    expect(o.pause_offer_enabled).toBe(true)
    expect(o.pause_max_weeks).toBe(4)
    expect(o.notice_days).toBe(30)
    expect(o.reasons).toEqual(Object.entries(copy.reason_labels).map(([code, label]) => ({ code, label })))
  })
})

describe('SubmitSchema', () => {
  it('accepts a pause and a cancel shape, rejects anything else', () => {
    expect(SubmitSchema.safeParse({ choice: 'pause', start_date: '2026-09-10', end_date: '2026-10-01' }).success).toBe(true)
    expect(SubmitSchema.safeParse({ choice: 'cancel', reason_code: 'price', requested_end_date: '2026-10-05', confirm: true }).success).toBe(true)
    expect(SubmitSchema.safeParse({ choice: 'cancel', reason_code: 'price', requested_end_date: '2026-10-05', confirm: false }).success).toBe(false)
    expect(SubmitSchema.safeParse({ choice: 'cancel', reason_code: 'bogus', requested_end_date: '2026-10-05', confirm: true }).success).toBe(false)
    expect(SubmitSchema.safeParse({ choice: 'cancel', reason_code: 'price', requested_end_date: '05/10/2026', confirm: true }).success).toBe(false)
    expect(SubmitSchema.safeParse({ choice: 'refund' }).success).toBe(false)
  })
})

describe('validateSubmission — cancel', () => {
  const cancel = (over = {}) => ({ choice: 'cancel', reason_code: 'price', reason_text: '  Too dear now  ', requested_end_date: '2026-10-05', confirm: true, ...over })

  it('builds the request row shape from a valid cancel', () => {
    const out = validateSubmission(cancel(), { ...copy, notice_days: 30 }, TODAY)
    expect(out.ok).toBe(true)
    expect(out.kind).toBe('cancellation')
    expect(out.details).toMatchObject({
      source: 'cancellation_form', reason_code: 'price', reason: 'Too dear now', requested_end_date: '2026-10-05',
      pause_offered: true, pause_taken: false,
    })
    expect(out.customerNote).toBe('Too dear now')
    expect(out.summary).toContain('The price')
  })

  it('uses the reason label as the customer note when no free text was given', () => {
    const out = validateSubmission(cancel({ reason_text: '' }), copy, TODAY)
    expect(out.customerNote).toBe('The price')
    expect(out.details.reason).toBe('The price')
  })

  it('refuses an end date inside the notice period or too far out', () => {
    expect(validateSubmission(cancel({ requested_end_date: '2026-10-04' }), { ...copy, notice_days: 30 }, TODAY)).toMatchObject({ ok: false, field: 'requested_end_date' })
    expect(validateSubmission(cancel({ requested_end_date: '2027-09-05' }), copy, TODAY)).toMatchObject({ ok: false, field: 'requested_end_date' })
    expect(validateSubmission(cancel({ requested_end_date: TODAY }), { ...copy, notice_days: 0 }, TODAY).ok).toBe(true)
  })

  it('records that the pause offer was NOT shown when the operator disabled it', () => {
    const out = validateSubmission(cancel(), { ...copy, pause_offer_enabled: false }, TODAY)
    expect(out.details.pause_offered).toBe(false)
  })
})

describe('validateSubmission — pause', () => {
  const pause = (over = {}) => ({ choice: 'pause', start_date: '2026-09-10', end_date: '2026-10-08', note: ' Away for work ', ...over })

  it('builds a pause request within the allowed span', () => {
    const out = validateSubmission(pause(), copy, TODAY)
    expect(out.ok).toBe(true)
    expect(out.kind).toBe('pause')
    expect(out.details).toMatchObject({ source: 'cancellation_form', start_date: '2026-09-10', end_date: '2026-10-08', pause_offered: true, pause_taken: true })
    expect(out.details.reason).toBe('Away for work')
    expect(out.customerNote).toBe('Away for work')
  })

  it('refuses a pause when the offer is off, when it starts in the past, ends before it starts, or runs too long', () => {
    expect(validateSubmission(pause(), { ...copy, pause_offer_enabled: false }, TODAY)).toMatchObject({ ok: false, field: 'choice' })
    expect(validateSubmission(pause({ start_date: '2026-09-04' }), copy, TODAY)).toMatchObject({ ok: false, field: 'start_date' })
    expect(validateSubmission(pause({ end_date: '2026-09-10' }), copy, TODAY)).toMatchObject({ ok: false, field: 'end_date' })
    expect(validateSubmission(pause({ end_date: '2026-11-06' }), { ...copy, pause_max_weeks: 8 }, TODAY)).toMatchObject({ ok: false, field: 'end_date' })
    expect(validateSubmission(pause({ end_date: '2026-11-05' }), { ...copy, pause_max_weeks: 8 }, TODAY).ok).toBe(true)
  })
})
