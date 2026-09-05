// CANCEL-FORM.2 — operator-editable copy for the membership cancellation
// form. Every string a member sees ships as a code default behind a settings
// field (customer-comms-editable rule); this suite pins the defaults'
// hygiene and the resolve/render behaviour.

import { describe, it, expect } from 'vitest'
import {
  CANCELLATION_FORM_DEFAULTS,
  CANCELLATION_FORM_TEXT_KEYS,
  REASON_CODES,
  resolveCancellationFormCopy,
  renderCopy,
} from './copy.js'

describe('CANCELLATION_FORM_DEFAULTS', () => {
  it('has no em dashes or emoji in any customer-facing string', () => {
    for (const key of CANCELLATION_FORM_TEXT_KEYS) {
      const v = CANCELLATION_FORM_DEFAULTS[key]
      expect(typeof v, key).toBe('string')
      expect(v, key).not.toMatch(/—/)
      expect(v, key).not.toMatch(/\p{Extended_Pictographic}/u)
    }
    for (const label of Object.values(CANCELLATION_FORM_DEFAULTS.reason_labels)) {
      expect(label).not.toMatch(/—/)
    }
  })

  it('labels every reason code exactly once', () => {
    expect(Object.keys(CANCELLATION_FORM_DEFAULTS.reason_labels).sort()).toEqual([...REASON_CODES].sort())
  })

  it('carries the placeholders the senders substitute', () => {
    expect(CANCELLATION_FORM_DEFAULTS.email_body).toContain('{link}')
    expect(CANCELLATION_FORM_DEFAULTS.cancel_confirmation_text).toContain('{end_date}')
    expect(CANCELLATION_FORM_DEFAULTS.pause_confirmation_text).toContain('{start_date}')
    expect(CANCELLATION_FORM_DEFAULTS.pause_confirmation_text).toContain('{end_date}')
    expect(CANCELLATION_FORM_DEFAULTS.whatsapp_button_text.length).toBeLessThanOrEqual(20)
  })

  it('ships the agreed non-copy defaults: pause offer on, 8 weeks, 0 notice days, no template, no base url', () => {
    expect(CANCELLATION_FORM_DEFAULTS.pause_offer_enabled).toBe(true)
    expect(CANCELLATION_FORM_DEFAULTS.pause_max_weeks).toBe(8)
    expect(CANCELLATION_FORM_DEFAULTS.notice_days).toBe(0)
    expect(CANCELLATION_FORM_DEFAULTS.whatsapp_template_name).toBeNull()
    expect(CANCELLATION_FORM_DEFAULTS.public_base_url).toBeNull()
  })
})

describe('resolveCancellationFormCopy', () => {
  it('returns the defaults for a missing / null / non-object blob', () => {
    expect(resolveCancellationFormCopy(null)).toEqual(CANCELLATION_FORM_DEFAULTS)
    expect(resolveCancellationFormCopy(undefined)).toEqual(CANCELLATION_FORM_DEFAULTS)
    expect(resolveCancellationFormCopy('nope')).toEqual(CANCELLATION_FORM_DEFAULTS)
  })

  it('operator values win; blank or null strings fall back to the default', () => {
    const out = resolveCancellationFormCopy({
      form_intro: 'Custom intro {first_name}',
      email_subject: '   ',
      thanks_cancel_text: null,
      pause_max_weeks: 4,
      notice_days: 30,
      pause_offer_enabled: false,
    })
    expect(out.form_intro).toBe('Custom intro {first_name}')
    expect(out.email_subject).toBe(CANCELLATION_FORM_DEFAULTS.email_subject)
    expect(out.thanks_cancel_text).toBe(CANCELLATION_FORM_DEFAULTS.thanks_cancel_text)
    expect(out.pause_max_weeks).toBe(4)
    expect(out.notice_days).toBe(30)
    expect(out.pause_offer_enabled).toBe(false)
  })

  it('merges reason labels per code so one override does not drop the rest', () => {
    const out = resolveCancellationFormCopy({ reason_labels: { price: 'Too dear', bogus: 'x' } })
    expect(out.reason_labels.price).toBe('Too dear')
    expect(out.reason_labels.moving).toBe(CANCELLATION_FORM_DEFAULTS.reason_labels.moving)
    expect('bogus' in out.reason_labels).toBe(false)
  })

  it('never lets a stored value break the invariants: bad numbers fall back', () => {
    const out = resolveCancellationFormCopy({ pause_max_weeks: 'lots', notice_days: -4 })
    expect(out.pause_max_weeks).toBe(8)
    expect(out.notice_days).toBe(0)
  })
})

describe('renderCopy', () => {
  it('substitutes single-brace placeholders and strips em dashes', () => {
    expect(renderCopy('Hi {first_name} — your plan {plan} ends {end_date}.', {
      first_name: 'Aoife', plan: 'Unlimited', end_date: '5 October 2026',
    })).toBe('Hi Aoife, your plan Unlimited ends 5 October 2026.')
  })

  it('drops an unknown or empty placeholder cleanly rather than printing braces', () => {
    expect(renderCopy('Hi {first_name}, see {nothing}.', { first_name: '' })).toBe('Hi there, see .')
  })

  it('tolerates a non-string template', () => {
    expect(renderCopy(null, {})).toBe('')
  })
})
