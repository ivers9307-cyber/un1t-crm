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
