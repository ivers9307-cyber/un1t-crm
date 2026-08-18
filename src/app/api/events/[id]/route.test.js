import { describe, it, expect } from 'vitest'
import { UpdateSchema } from './route'

// EVENTS-EMAILCFG.1 — per-event email config on the events update schema.
// Every field is optional (omit = leave untouched) and nullable (null =
// clear back to the default copy/look). template pointers are uuidLike.
describe('events UpdateSchema email config', () => {
  it('parses clean with no email fields set', () => {
    const parsed = UpdateSchema.parse({ name: 'Renamed event' })
    expect(parsed.confirmation_email_subject).toBeUndefined()
    expect(parsed.reminder_email_template_id).toBeUndefined()
  })

  it('accepts subject/intro edits and template pointers', () => {
    const parsed = UpdateSchema.parse({
      confirmation_email_subject: 'Welcome {{team_name}}',
      confirmation_email_intro: 'Doors open at {{when}}.',
      reminder_email_subject: 'See you at {{event_name}}',
      reminder_email_intro: 'Reminder for {{team_name}}.',
      confirmation_email_template_id: '22222222-2222-2222-2222-222222222222',
      reminder_email_template_id: '33333333-3333-3333-3333-333333333333',
    })
    expect(parsed.confirmation_email_template_id).toBe('22222222-2222-2222-2222-222222222222')
    expect(parsed.reminder_email_subject).toContain('event_name')
  })

  it('accepts null to clear copy + template pointers', () => {
    const parsed = UpdateSchema.parse({
      confirmation_email_intro: null,
      reminder_email_intro: null,
      confirmation_email_template_id: null,
      reminder_email_template_id: null,
    })
    expect(parsed.confirmation_email_intro).toBeNull()
    expect(parsed.confirmation_email_template_id).toBeNull()
  })

  it('rejects a non-uuid template pointer', () => {
    expect(() =>
      UpdateSchema.parse({ reminder_email_template_id: 'nope' }),
    ).toThrow()
  })

  it('rejects copy over the max length', () => {
    expect(() =>
      UpdateSchema.parse({ reminder_email_intro: 'y'.repeat(4001) }),
    ).toThrow()
  })
})

// EVENTS-SMS-TOGGLE (mig 552) — per-event opt-in for the registration SMS
// confirmation. Optional boolean; flows through the generic scalar patch in
// PUT (omit = leave untouched).
describe('events UpdateSchema SMS confirmation toggle', () => {
  it('parses clean when the flag is omitted (leave untouched)', () => {
    expect(UpdateSchema.parse({ name: 'Renamed event' }).confirmation_sms_enabled).toBeUndefined()
  })

  it('accepts an explicit boolean either way', () => {
    expect(UpdateSchema.parse({ confirmation_sms_enabled: true }).confirmation_sms_enabled).toBe(true)
    expect(UpdateSchema.parse({ confirmation_sms_enabled: false }).confirmation_sms_enabled).toBe(false)
  })

  it('rejects a non-boolean', () => {
    expect(() => UpdateSchema.parse({ confirmation_sms_enabled: 'sure' })).toThrow()
  })
})
