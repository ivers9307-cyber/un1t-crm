// MIA-HYGIENE.1 — the settings write-through contract. The customer-agent PUT
// used to build its persisted object field-by-field, and twice shipped a
// schema key that validated but never got WRITTEN (#495: followups /
// first_class_checkin / agent_name / handoff_cooldown_hours; audit 2026-08-19:
// effort / handoff_after_verify_failures were read live but unreachable from
// the editor). This suite makes the omission a CI failure instead of a silent
// prod drop: every SettingsSchema key must survive into the built blob.
import { describe, it, expect } from 'vitest'
import { SettingsSchema, DEFAULTS, buildCustomerAgentSettings } from './settings-contract'

// social_enabled is a top-level sibling on locations.settings (written next to
// customer_agent, not inside it) — the one documented exception.
// CANCEL-FORM.2 — glofox_auto_cancel is the locations.glofox_auto_cancel_memberships
// COLUMN, written by the route next to social_enabled.
const SIBLING_KEYS = ['social_enabled', 'glofox_auto_cancel']

describe('settings write-through contract', () => {
  it('every schema key except documented siblings survives into the written blob', () => {
    const parsed = SettingsSchema.parse({ enabled: true })
    const built = buildCustomerAgentSettings(parsed)
    const missing = Object.keys(SettingsSchema.shape)
      .filter((k) => !SIBLING_KEYS.includes(k))
      .filter((k) => !(k in built))
    expect(missing).toEqual([])
  })

  it('effort round-trips; absent → null (core defaults to medium)', () => {
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, effort: 'low' })).effort,
    ).toBe('low')
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).effort).toBe(null)
  })

  it('rejects an effort value outside the enum', () => {
    expect(SettingsSchema.safeParse({ enabled: true, effort: 'ultra' }).success).toBe(false)
  })

  it('handoff_after_verify_failures round-trips; absent → null (core defaults to 2)', () => {
    expect(
      buildCustomerAgentSettings(
        SettingsSchema.parse({ enabled: true, handoff_after_verify_failures: 3 }),
      ).handoff_after_verify_failures,
    ).toBe(3)
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true }))
        .handoff_after_verify_failures,
    ).toBe(null)
  })

  // PERSON-ACCT.7 — the deterministic script for the two-live-accounts
  // handoff. A customer-facing string that never reaches the blob is the
  // failure mode this whole file exists for (#495).
  it('account_conflict_handoff_text round-trips; blank → null (core default)', () => {
    expect(
      buildCustomerAgentSettings(
        SettingsSchema.parse({ enabled: true, account_conflict_handoff_text: '  Two accounts — a coach will sort it.  ' }),
      ).account_conflict_handoff_text,
    ).toBe('Two accounts — a coach will sort it.')
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, account_conflict_handoff_text: '   ' }))
        .account_conflict_handoff_text,
    ).toBe(null)
    expect(DEFAULTS.account_conflict_handoff_text).toBe(null)
  })

  // CANCEL-FORM.2 — the cancellation-form copy block. Null = every code default
  // (lib/cancellation-form/copy.js); an object round-trips with strings trimmed
  // and blanks nulled so the resolver falls back per key.
  it('cancellation_form round-trips as a nested block; absent → null', () => {
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).cancellation_form).toBe(null)
    const built = buildCustomerAgentSettings(SettingsSchema.parse({
      enabled: true,
      cancellation_form: {
        form_intro: '  Hi {first_name}  ',
        email_subject: '   ',
        pause_max_weeks: 6,
        notice_days: 14,
        pause_offer_enabled: false,
        reason_labels: { price: ' Too dear ' },
        whatsapp_template_name: 'cancellation_form_link',
        public_base_url: 'https://un1tdublin.com',
      },
    }))
    expect(built.cancellation_form.form_intro).toBe('Hi {first_name}')
    expect(built.cancellation_form.email_subject).toBe(null)
    expect(built.cancellation_form.pause_max_weeks).toBe(6)
    expect(built.cancellation_form.notice_days).toBe(14)
    expect(built.cancellation_form.pause_offer_enabled).toBe(false)
    expect(built.cancellation_form.reason_labels).toEqual({ price: 'Too dear' })
    expect(built.cancellation_form.whatsapp_template_name).toBe('cancellation_form_link')
    expect(built.cancellation_form.public_base_url).toBe('https://un1tdublin.com')
    expect(DEFAULTS.cancellation_form).toBe(null)
  })

  it('cancellation_form rejects a non-URL base url and an out-of-range notice period; blank url → null', () => {
    expect(SettingsSchema.safeParse({ enabled: true, cancellation_form: { public_base_url: 'not a url' } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, cancellation_form: { notice_days: 400 } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, cancellation_form: { whatsapp_button_text: 'x'.repeat(21) } }).success).toBe(false)
    const parsed = SettingsSchema.parse({ enabled: true, cancellation_form: { public_base_url: '' } })
    expect(buildCustomerAgentSettings(parsed).cancellation_form.public_base_url).toBe(null)
  })

  it('glofox_auto_cancel parses as a boolean sibling and is NOT written into the blob', () => {
    const parsed = SettingsSchema.parse({ enabled: true, glofox_auto_cancel: true })
    expect(parsed.glofox_auto_cancel).toBe(true)
    expect(SettingsSchema.parse({ enabled: true }).glofox_auto_cancel).toBe(false)
    expect('glofox_auto_cancel' in buildCustomerAgentSettings(parsed)).toBe(false)
  })

  it('existing transforms hold: trim-to-null, agent_name default, nested merges', () => {
    const built = buildCustomerAgentSettings(
      SettingsSchema.parse({
        enabled: true,
        tone: '  ',
        agent_name: ' ',
        followups: { enabled: true },
      }),
    )
    expect(built.tone).toBe(null)
    expect(built.agent_name).toBe(DEFAULTS.agent_name)
    expect(built.followups).toEqual({ ...DEFAULTS.followups, enabled: true })
  })
})
