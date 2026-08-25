import { describe, it, expect } from 'vitest'
import { CreateSchema } from './route'

// EVENTS-EMAILCFG.1 — per-event email config on the events create schema.
// The confirmation/reminder subject + intro copy and the two full-template
// pointers are all optional + nullable. Behaviour-preserving: an event
// created with none of these set parses clean (all absent → persisted NULL).
describe('events CreateSchema email config', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim',
    race_date: '2026-08-01',
    waves: [{ start_time: '09:00' }],
  }

  it('parses clean with no email config set (behaviour-preserving default)', () => {
    const parsed = CreateSchema.parse({ ...base })
    expect(parsed.confirmation_email_subject).toBeUndefined()
    expect(parsed.confirmation_email_intro).toBeUndefined()
    expect(parsed.reminder_email_subject).toBeUndefined()
    expect(parsed.reminder_email_intro).toBeUndefined()
    expect(parsed.confirmation_email_template_id).toBeUndefined()
    expect(parsed.reminder_email_template_id).toBeUndefined()
  })

  it('accepts subject + intro copy for both emails', () => {
    const parsed = CreateSchema.parse({
      ...base,
      confirmation_email_subject: 'You\'re in, {{team_name}}!',
      confirmation_email_intro: 'See you at {{event_name}} on {{when}}.',
      reminder_email_subject: 'Tomorrow: {{event_name}}',
      reminder_email_intro: 'Final details for {{team_name}}.',
    })
    expect(parsed.confirmation_email_subject).toContain('team_name')
    expect(parsed.reminder_email_intro).toContain('team_name')
  })

  it('accepts null to clear each copy field', () => {
    const parsed = CreateSchema.parse({
      ...base,
      confirmation_email_subject: null,
      confirmation_email_intro: null,
      reminder_email_subject: null,
      reminder_email_intro: null,
    })
    expect(parsed.confirmation_email_intro).toBeNull()
    expect(parsed.reminder_email_subject).toBeNull()
  })

  it('accepts uuid template pointers and null', () => {
    const parsed = CreateSchema.parse({
      ...base,
      confirmation_email_template_id: '11111111-1111-1111-1111-111111111111',
      reminder_email_template_id: null,
    })
    expect(parsed.confirmation_email_template_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(parsed.reminder_email_template_id).toBeNull()
  })

  it('rejects a non-uuid template pointer', () => {
    expect(() =>
      CreateSchema.parse({ ...base, confirmation_email_template_id: 'not-a-uuid' }),
    ).toThrow()
  })

  it('rejects copy that exceeds the max length', () => {
    expect(() =>
      CreateSchema.parse({ ...base, confirmation_email_intro: 'x'.repeat(4001) }),
    ).toThrow()
  })
})

// EVENTS-SMS-TOGGLE (mig 552) — per-event opt-in for the registration SMS
// confirmation. Optional boolean on the schema; the POST route defaults it
// to false when omitted, so a legacy/default event never texts.
describe('events CreateSchema SMS confirmation toggle', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim',
    race_date: '2026-08-01',
    waves: [{ start_time: '09:00' }],
  }

  it('parses clean with the flag absent (route defaults it off)', () => {
    expect(CreateSchema.parse({ ...base }).confirmation_sms_enabled).toBeUndefined()
  })

  it('accepts an explicit boolean either way', () => {
    expect(CreateSchema.parse({ ...base, confirmation_sms_enabled: true }).confirmation_sms_enabled).toBe(true)
    expect(CreateSchema.parse({ ...base, confirmation_sms_enabled: false }).confirmation_sms_enabled).toBe(false)
  })

  it('rejects a non-boolean', () => {
    expect(() => CreateSchema.parse({ ...base, confirmation_sms_enabled: 'yes' })).toThrow()
  })
})

describe('events CreateSchema sending_location_id', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim', race_date: '2026-08-01', waves: [{ start_time: '09:00' }],
  }
  it('parses clean when omitted', () => {
    expect(CreateSchema.parse({ ...base }).sending_location_id).toBeUndefined()
  })
  it('accepts a uuid and null', () => {
    expect(CreateSchema.parse({ ...base, sending_location_id: '11111111-1111-1111-1111-111111111111' }).sending_location_id)
      .toBe('11111111-1111-1111-1111-111111111111')
    expect(CreateSchema.parse({ ...base, sending_location_id: null }).sending_location_id).toBeNull()
  })
  it('rejects a non-uuid', () => {
    expect(() => CreateSchema.parse({ ...base, sending_location_id: 'nope' })).toThrow()
  })
})
