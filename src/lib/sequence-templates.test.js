// Sanity check on the SEQUENCE_TEMPLATES catalog. Lightweight — we
// don't validate every operator-editable string, but we DO want to
// know if the Glofox welcome template (GLOFOX3.5) loses its trigger
// tag, drops a step, or stops referencing the passcode merge tag,
// because any of those would silently break the operator-facing
// onboarding flow we just shipped.

import { describe, it, expect } from 'vitest'
import { SEQUENCE_TEMPLATES, getTemplate, TEMPLATE_CATEGORIES } from './sequence-templates.js'

describe('SEQUENCE_TEMPLATES catalog', () => {
  it('every template has a stable id, category, name, trigger, and at least one step', () => {
    for (const t of SEQUENCE_TEMPLATES) {
      expect(t.id, `template missing id: ${JSON.stringify(t.name)}`).toBeTruthy()
      expect(t.category, `${t.id} missing category`).toBeTruthy()
      expect(t.name, `${t.id} missing name`).toBeTruthy()
      expect(t.trigger_type, `${t.id} missing trigger_type`).toBeTruthy()
      expect(Array.isArray(t.steps), `${t.id} steps not array`).toBe(true)
      expect(t.steps.length, `${t.id} has no steps`).toBeGreaterThan(0)
    }
  })

  it('every template category appears in TEMPLATE_CATEGORIES', () => {
    for (const t of SEQUENCE_TEMPLATES) {
      expect(TEMPLATE_CATEGORIES, `${t.id} category ${t.category} not in TEMPLATE_CATEGORIES`).toContain(t.category)
    }
  })

  it('ids are unique', () => {
    const ids = SEQUENCE_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('getTemplate returns the matching entry by id', () => {
    const first = SEQUENCE_TEMPLATES[0]
    expect(getTemplate(first.id)).toBe(first)
    expect(getTemplate('does-not-exist')).toBeNull()
  })
})

// GLOFOX4.4 — the four trial-lifecycle templates. Locking down the
// trigger tag + comms-only step lists so a refactor to either side
// can't silently break the conversion flow. FUNNEL.1 retired the
// move_pipeline_stage step type (stage placement is classifier-
// derived), so NO template may ship one any more.
describe('GLOFOX4.4 trial-lifecycle templates', () => {
  const engagedTpl = getTemplate('glofox_trial_engaged_to_conversion')
  const creditsTpl = getTemplate('glofox_trial_credits_low_push')
  const endedTpl   = getTemplate('glofox_trial_ended_winback')
  const convertedTpl = getTemplate('glofox_trial_converted_welcome')

  it('no template anywhere ships a move_pipeline_stage step (retired in FUNNEL.1)', () => {
    for (const tpl of SEQUENCE_TEMPLATES) {
      expect(
        tpl.steps.find((s) => s.step_type === 'move_pipeline_stage'),
        `${tpl.id} still ships a retired move_pipeline_stage step`,
      ).toBeUndefined()
    }
  })

  it('engaged template fires on glofox_trial_engaged and is comms-only (wait → email → sms)', () => {
    expect(engagedTpl).not.toBeNull()
    expect(engagedTpl.trigger_type).toBe('tag_added')
    expect(engagedTpl.trigger_config?.tag).toBe('glofox_trial_engaged')
    // The leading 2h wait preserves the send timing the template had
    // before its move step was retired.
    expect(engagedTpl.steps.map((s) => s.step_type)).toEqual(['wait', 'email', 'sms'])
    expect(engagedTpl.steps[0].delay_hours).toBe(2)
  })

  it('credits-low template fires on glofox_trial_credits_low and is comms-only (sms → email)', () => {
    expect(creditsTpl).not.toBeNull()
    expect(creditsTpl.trigger_type).toBe('tag_added')
    expect(creditsTpl.trigger_config?.tag).toBe('glofox_trial_credits_low')
    expect(creditsTpl.steps.map((s) => s.step_type)).toEqual(['sms', 'email'])
  })

  it('trial-ended template fires on glofox_trial_ended (comms-only)', () => {
    expect(endedTpl).not.toBeNull()
    expect(endedTpl.trigger_type).toBe('tag_added')
    expect(endedTpl.trigger_config?.tag).toBe('glofox_trial_ended')
  })

  it('trial-converted template fires on glofox_trial_converted (comms-only)', () => {
    expect(convertedTpl).not.toBeNull()
    expect(convertedTpl.trigger_type).toBe('tag_added')
    expect(convertedTpl.trigger_config?.tag).toBe('glofox_trial_converted')
  })

  it('every trial-lifecycle template uses a long re-enrolment cooldown', () => {
    // Re-firing a conversion push or a win-back drip on every cron
    // pass would harass the same contact repeatedly. Long cooldown
    // is the safety belt.
    for (const tpl of [engagedTpl, creditsTpl, endedTpl, convertedTpl]) {
      expect(tpl.re_enrolment_cooldown_days, `${tpl.id} cooldown too short`).toBeGreaterThanOrEqual(180)
    }
  })
})

describe('GLOFOX3.5 welcome template', () => {
  const tpl = getTemplate('glofox_welcome_passcode')

  it('exists', () => {
    expect(tpl).not.toBeNull()
  })

  it('fires on the glofox_account_created tag', () => {
    // glofox-push.js writes this tag when a fresh Glofox account is
    // created. Changing it here without updating the push helper
    // (or vice versa) would silently break the welcome flow.
    expect(tpl.trigger_type).toBe('tag_added')
    expect(tpl.trigger_config?.tag).toBe('glofox_account_created')
  })

  it('sits in the Welcome category', () => {
    expect(tpl.category).toBe('Welcome')
  })

  it('first step is the immediate email containing the passcode merge tag', () => {
    const step = tpl.steps[0]
    expect(step.step_type).toBe('email')
    expect(step.delay_days).toBe(0)
    expect(step.delay_hours).toBe(0)
    expect(step.html_content).toContain('{{glofox_passcode}}')
    expect(step.html_content).toContain('{{email}}')
  })

  it('also surfaces the passcode via SMS as a backup channel', () => {
    // Junk-folder insurance — we want the passcode on at least two
    // channels.
    const smsStep = tpl.steps.find((s) => s.step_type === 'sms')
    expect(smsStep, 'no SMS step in the welcome template').toBeTruthy()
    expect(smsStep.sms_body).toContain('{{glofox_passcode}}')
  })

  it('uses a long re-enrolment cooldown so a stale passcode isn\'t re-emailed', () => {
    // A passcode is minted once per Glofox account. If the same tag
    // somehow fires again, we don't want to email the OLD passcode.
    expect(tpl.re_enrolment_cooldown_days).toBeGreaterThanOrEqual(180)
  })
})

// COMMSFIX.E.4 — customer-facing template copy house rules.
//
// Richard's standing rules for customer copy: no em-dashes (the AI
// tell), no emoji, no gush. Plus two correctness rules from the
// 2026-08-09 audit: no hard-coded 'Stillorgan' (wrong for any second
// location — {{location_name}} is the merge tag, and sendEmailStep/
// sendSmsStep both resolve it now), and no '{{event_name}}' (the tag
// does not exist in applyMergeTags — unknown tokens pass through
// VERBATIM, so customers received the literal token in subject lines).
describe('COMMSFIX.E.4 — customer-facing template copy house rules', () => {
  // Customer-facing strings only: step subjects, email bodies, SMS
  // bodies. Template descriptions are staff-facing picker copy and
  // internal_task configs never reach a customer.
  const customerStrings = SEQUENCE_TEMPLATES.flatMap((t) =>
    t.steps.flatMap((s, i) =>
      [['subject', s.subject], ['html_content', s.html_content], ['sms_body', s.sms_body]]
        .filter(([, v]) => typeof v === 'string' && v.length > 0)
        .map(([key, value]) => ({ label: `${t.id}.steps[${i}].${key}`, value }))))

  it('collects a non-trivial corpus (sanity)', () => {
    expect(customerStrings.length).toBeGreaterThan(30)
  })

  it('contains no em-dashes', () => {
    for (const s of customerStrings) {
      expect(s.value, s.label).not.toContain('—')
    }
  })

  it('contains no emoji', () => {
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u
    for (const s of customerStrings) {
      expect(emoji.test(s.value), `${s.label} contains emoji: ${s.value}`).toBe(false)
    }
  })

  it('contains no hard-coded Stillorgan (must be {{location_name}})', () => {
    for (const s of customerStrings) {
      expect(s.value, s.label).not.toMatch(/stillorgan/i)
    }
  })

  it('references no non-existent {{event_name}} merge tag', () => {
    for (const s of customerStrings) {
      expect(s.value, s.label).not.toContain('{{event_name}}')
    }
  })

  it('race_welcome copy is registration-relative (no race-day claims at registration time)', () => {
    // The trigger is race_registered — step offsets are relative to the
    // moment of REGISTRATION, which can be weeks before the race. 'Your
    // race is tomorrow' / 'Big effort today' belong to an event_reminder
    // or race_finished trigger, never here.
    const tpl = getTemplate('race_welcome')
    for (const [i, s] of tpl.steps.entries()) {
      const text = `${s.subject || ''} ${s.html_content || ''} ${s.sms_body || ''}`
      expect(text, `race_welcome.steps[${i}]`).not.toMatch(/race is tomorrow|big effort today|thanks for racing/i)
    }
  })

  it('birthday_wishes description matches the engine (dob month+day, yearly re-fire)', () => {
    const tpl = getTemplate('birthday_wishes')
    expect(tpl.description).toMatch(/month and day/i)
    expect(tpl.trigger_config).toEqual({ from_field: 'dob', days_after: 0 })
  })
})

// RADAR-DUNNING.1 — the overdue-payment dunning template. Locks down
// the segment_added trigger + multi-channel shape so a refactor can't
// silently break the automated arrears chase.
describe('RADAR-DUNNING.1 overdue dunning template', () => {
  const tpl = getTemplate('overdue_payment_dunning')

  it('exists in the Recovery category', () => {
    expect(tpl).not.toBeNull()
    expect(tpl.category).toBe('Recovery')
  })

  it('fires on a segment_added trigger with an operator-configured segment', () => {
    // Config ships empty — the operator points it at their
    // "Membership State = locked" segment after cloning.
    expect(tpl.trigger_type).toBe('segment_added')
    expect(tpl.trigger_config).toEqual({})
  })

  it('is a multi-touch drip across email and SMS', () => {
    expect(tpl.steps.length).toBeGreaterThanOrEqual(3)
    expect(tpl.steps.some((s) => s.step_type === 'email')).toBe(true)
    expect(tpl.steps.some((s) => s.step_type === 'sms')).toBe(true)
  })

  it('has a re-enrolment cooldown so a member is not re-chased every cron tick', () => {
    expect(tpl.re_enrolment_cooldown_days).toBeGreaterThan(0)
  })
})
