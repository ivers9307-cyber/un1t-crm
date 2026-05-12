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
// trigger tag + the pipeline-move step config so a refactor to
// either side can't silently break the conversion flow.
describe('GLOFOX4.4 trial-lifecycle templates', () => {
  const engagedTpl = getTemplate('glofox_trial_engaged_to_conversion')
  const creditsTpl = getTemplate('glofox_trial_credits_low_push')
  const endedTpl   = getTemplate('glofox_trial_ended_winback')
  const convertedTpl = getTemplate('glofox_trial_converted_welcome')

  it('engaged template fires on glofox_trial_engaged and moves to conversion_ready', () => {
    expect(engagedTpl).not.toBeNull()
    expect(engagedTpl.trigger_type).toBe('tag_added')
    expect(engagedTpl.trigger_config?.tag).toBe('glofox_trial_engaged')
    const move = engagedTpl.steps.find((s) => s.step_type === 'move_pipeline_stage')
    expect(move, 'no move_pipeline_stage step in engaged template').toBeTruthy()
    expect(move.config?.stage_slug).toBe('conversion_ready')
  })

  it('credits-low template fires on glofox_trial_credits_low and moves to conversion_ready', () => {
    expect(creditsTpl).not.toBeNull()
    expect(creditsTpl.trigger_type).toBe('tag_added')
    expect(creditsTpl.trigger_config?.tag).toBe('glofox_trial_credits_low')
    const move = creditsTpl.steps.find((s) => s.step_type === 'move_pipeline_stage')
    expect(move).toBeTruthy()
    expect(move.config?.stage_slug).toBe('conversion_ready')
  })

  it('trial-ended template fires on glofox_trial_ended and does NOT move pipeline', () => {
    // Win-back drip stays in Follow-up Needed where the GLOFOX2.1.4
    // auto-mover put them. Sequence just sends comms.
    expect(endedTpl).not.toBeNull()
    expect(endedTpl.trigger_type).toBe('tag_added')
    expect(endedTpl.trigger_config?.tag).toBe('glofox_trial_ended')
    expect(endedTpl.steps.find((s) => s.step_type === 'move_pipeline_stage')).toBeUndefined()
  })

  it('trial-converted template fires on glofox_trial_converted and does NOT move pipeline', () => {
    // applyMemberSync GLOFOX2.1.4 already moves trial → member's
    // deal to the Member stage. Welcome sequence is comms-only.
    expect(convertedTpl).not.toBeNull()
    expect(convertedTpl.trigger_type).toBe('tag_added')
    expect(convertedTpl.trigger_config?.tag).toBe('glofox_trial_converted')
    expect(convertedTpl.steps.find((s) => s.step_type === 'move_pipeline_stage')).toBeUndefined()
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
