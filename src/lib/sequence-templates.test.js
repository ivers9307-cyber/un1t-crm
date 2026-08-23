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

// GAPS-P3 — the anniversary templates and the cron whitelist they drive.
//
// Nothing used to hold the SHIPPED templates against
// runAnniversaryTriggers' allowed from_field list. A typo in a template
// ships a sequence the cron refuses to run: it logs an error and skips,
// once per tick, forever, and the only place that shows up is the log.
// These tests make the whitelist a machine-checked contract instead.
describe('GAPS-P3 — anniversary templates drive a from_field the cron accepts', () => {
  const anniversaryTemplates = SEQUENCE_TEMPLATES.filter((t) => t.trigger_type === 'anniversary')

  it('the catalog actually ships anniversary templates (sanity)', () => {
    expect(anniversaryTemplates.length).toBeGreaterThan(0)
  })

  it('every anniversary template names a from_field in ANNIVERSARY_FROM_FIELDS', async () => {
    const { ANNIVERSARY_FROM_FIELDS } = await import('@/lib/sequences/anniversary-fields')
    for (const tpl of anniversaryTemplates) {
      const field = tpl.trigger_config?.from_field
      expect(field, `${tpl.id} has no trigger_config.from_field`).toBeTruthy()
      expect(
        ANNIVERSARY_FROM_FIELDS.includes(field),
        `${tpl.id} drives from_field '${field}', which runAnniversaryTriggers rejects — the sequence would never fire`,
      ).toBe(true)
    }
  })

  it('every anniversary template sets a numeric days_after', () => {
    for (const tpl of anniversaryTemplates) {
      const days = tpl.trigger_config?.days_after
      expect(Number.isFinite(days), `${tpl.id} days_after is not a number`).toBe(true)
      expect(days, `${tpl.id} days_after is negative`).toBeGreaterThanOrEqual(0)
    }
  })

  it('the cron guard and the template catalog read the SAME allowed list', async () => {
    const cronTriggers = await import('@/lib/sequences/cron-triggers')
    const { ANNIVERSARY_FROM_FIELDS } = await import('@/lib/sequences/anniversary-fields')
    expect(cronTriggers.ANNIVERSARY_FROM_FIELDS).toBe(ANNIVERSARY_FROM_FIELDS)
  })
})

// GAPS-P3.1 — the 1-year anniversary template fired on lead_created_at,
// which at Stillorgan is the CRM ROW-IMPORT timestamp: its date equals
// created_at's date for all 8,509 contacts. Shipped as it was, the
// template would have greeted thousands of people at once on the
// anniversary of a bulk import, for nothing.
describe('GAPS-P3.1 — 1-year anniversary fires on the real membership start date', () => {
  const tpl = getTemplate('anniversary_one_year')

  it('exists', () => {
    expect(tpl).not.toBeNull()
  })

  it('fires on joined_at, NOT the poisoned lead_created_at import stamp', () => {
    expect(tpl.trigger_config).toEqual({ from_field: 'joined_at', days_after: 365 })
  })

  it('describes joining rather than naming the import column', () => {
    expect(tpl.description).toMatch(/join/i)
    expect(tpl.description).not.toMatch(/lead_created_at/)
  })
})

// GAPS-P3.3 — dob is on file for a minority of contacts, so the birthday
// recipe reaches a fraction of the list. That is not a bug, but an
// operator choosing it from the picker had no way to know. The note
// states the CONDITION, never a percentage (which drifts as dob fills in).
describe('GAPS-P3.3 — birthday template is honest about who it can reach', () => {
  const tpl = getTemplate('birthday_wishes')

  it('says it only reaches contacts whose date of birth is on file', () => {
    expect(tpl.description).toMatch(/date of birth/i)
    expect(tpl.description).toMatch(/on file|on record|recorded/i)
  })

  it('quotes no coverage percentage (the number drifts, the condition does not)', () => {
    expect(tpl.description).not.toMatch(/\d+(\.\d+)?\s?%/)
  })
})

// GAPS-P3.4 — three recipes added for a single-site HIIT gym. Each one is
// pinned to the trigger + config the ENGINE actually reads, so a rename on
// either side fails here rather than shipping an inert sequence.
describe('GAPS-P3.4 — new gym recipes', () => {
  it('30-day check-in fires on the joined_at anniversary at day 30', () => {
    const tpl = getTemplate('new_member_30_day_checkin')
    expect(tpl, 'new_member_30_day_checkin missing').not.toBeNull()
    expect(tpl.category).toBe('Welcome')
    expect(tpl.trigger_type).toBe('anniversary')
    expect(tpl.trigger_config).toEqual({ from_field: 'joined_at', days_after: 30 })
  })

  it('paused-membership nudge fires on a membership_state_change TO paused', () => {
    const tpl = getTemplate('membership_paused_return')
    expect(tpl, 'membership_paused_return missing').not.toBeNull()
    expect(tpl.category).toBe('Recovery')
    expect(tpl.trigger_type).toBe('membership_state_change')
    expect(tpl.trigger_config).toEqual({ to_state: 'paused' })
    // Resuming is the win, so it exits as goal_met, not a drop-out.
    expect(tpl.goal_config).toEqual({ type: 'membership_state', value: 'active' })
  })

  it('second-class push fires on the glofox_first_booking platform tag', () => {
    const tpl = getTemplate('first_class_booked_second_class_push')
    expect(tpl, 'first_class_booked_second_class_push missing').not.toBeNull()
    expect(tpl.category).toBe('Lead conversion')
    expect(tpl.trigger_type).toBe('tag_added')
    expect(tpl.trigger_config).toEqual({ tag: 'glofox_first_booking' })
    expect(tpl.goal_config).toEqual({ type: 'pipeline_stage', value: 'second_class' })
  })

  it('every new recipe carries a re-enrolment cooldown', () => {
    for (const id of ['new_member_30_day_checkin', 'membership_paused_return', 'first_class_booked_second_class_push']) {
      expect(getTemplate(id).re_enrolment_cooldown_days, `${id} has no cooldown`).toBeGreaterThan(0)
    }
  })

  it('every tag-triggered template names a tag the platform actually writes', async () => {
    // A tag_added trigger on a tag nothing writes is an inert sequence —
    // the exact class of bug PLATFORM_TAGS was built to catch in the flow
    // builder. Hold the packaged templates to the same bar. There are no
    // exceptions: the last one (the win-back below) was repointed rather
    // than recorded.
    const { PLATFORM_TAGS } = await import('@/lib/sequences/tag-vocabulary')
    for (const tpl of SEQUENCE_TEMPLATES.filter((t) => t.trigger_type === 'tag_added')) {
      expect(
        PLATFORM_TAGS.includes(tpl.trigger_config?.tag),
        `${tpl.id} triggers on '${tpl.trigger_config?.tag}', which is not in PLATFORM_TAGS`,
      ).toBe(true)
    }
  })

  // WAS INERT, NOW REPOINTED.
  //
  // glofox_membership_cancelled_winback used to trigger on the tag
  // 'glofox_membership_cancelled', which nothing in this repo writes, so the
  // packaged win-back drip could never fire however an operator cloned and
  // activated it. Its description named a second invented tag,
  // 'glofox_membership_ended'.
  //
  // WHY 'cancelled' WAS NEVER A REAL SIGNAL. It was assumed, not observed.
  // The live Glofox event vocabulary for this account is twelve strings —
  // BOOKING_CREATED / _UPDATED / _DELETED, EVENT_CREATED / _UPDATED /
  // _DELETED, INVOICE_UPDATED, MEMBER_CREATED / _UPDATED, MEMBERSHIP_CREATED
  // / _UPDATED / _DELETED — and none of them is a cancellation or an expiry.
  // Glofox does not distinguish the two: a membership that is cancelled and
  // one that runs out both arrive as MEMBERSHIP_DELETED (34 delivered, most
  // recently 2026-08-06). So there was no semantic difference being
  // preserved by waiting, only a template that could not fire. The webhook
  // maps that event through EVENT_TYPE_TAGS in src/lib/glofox.js to exactly
  // one tag, 'glofox_membership_deleted', which is what the template names
  // now.
  it('the ex-member win-back triggers on the tag the webhook actually writes', async () => {
    const { PLATFORM_TAGS } = await import('@/lib/sequences/tag-vocabulary')
    const { tagsForGlofoxEvent } = await import('@/lib/glofox')
    const tpl = getTemplate('glofox_membership_cancelled_winback')
    expect(tpl.trigger_config.tag).toBe('glofox_membership_deleted')
    expect(PLATFORM_TAGS).toContain('glofox_membership_deleted')
    // The end-to-end claim: the event Glofox really sends produces this tag.
    expect(tagsForGlofoxEvent('MEMBERSHIP_DELETED')).toContain(tpl.trigger_config.tag)
  })

  it('the win-back description names no tag the platform does not write', async () => {
    // The old description advertised 'glofox_membership_cancelled OR
    // glofox_membership_ended', neither of which exists. An operator reading
    // the template picker was being told the wrong thing twice.
    const { PLATFORM_TAGS } = await import('@/lib/sequences/tag-vocabulary')
    const { description } = getTemplate('glofox_membership_cancelled_winback')
    const named = [...description.matchAll(/\bglofox_[a-z_]+\b/g)].map((m) => m[0])
    expect(named.length).toBeGreaterThan(0)
    for (const tag of named) {
      expect(PLATFORM_TAGS, `description names '${tag}', which nothing writes`).toContain(tag)
    }
  })

  it('every audience_filter field is a registered AUDIENCE_FIELDS entry with that operator', async () => {
    const { AUDIENCE_FIELDS } = await import('@/lib/audience-filter')
    for (const tpl of SEQUENCE_TEMPLATES) {
      for (const f of (tpl.audience_filter?.filters || [])) {
        const def = AUDIENCE_FIELDS[f.field]
        expect(def, `${tpl.id} filters on unregistered field '${f.field}'`).toBeDefined()
        expect(def.ops.includes(f.op), `${tpl.id}: op '${f.op}' invalid for '${f.field}'`).toBe(true)
      }
    }
  })
})

// RADAR-DUNNING.1 → DUNNING.6 — the overdue-payment dunning template. The
// segment_added "Membership State = locked" shape is retired (locked was a
// 56%-false-positive signal); the template is now the manual-trigger
// automation the radar's auto-enrol and one-click reminder enrol directly
// into — see the DUNNING.6 suite below for its exact shape.
describe('RADAR-DUNNING.1 overdue dunning template', () => {
  const tpl = getTemplate('overdue_payment_dunning')

  it('exists in the Recovery category', () => {
    expect(tpl).not.toBeNull()
    expect(tpl.category).toBe('Recovery')
  })

  it('is a multi-touch drip across WhatsApp and email (no SMS)', () => {
    expect(tpl.steps.length).toBeGreaterThanOrEqual(3)
    expect(tpl.steps.some((s) => s.step_type === 'email')).toBe(true)
    expect(tpl.steps.some((s) => s.step_type === 'whatsapp')).toBe(true)
    expect(tpl.steps.some((s) => s.step_type === 'sms')).toBe(false)
  })

  it('has a re-enrolment cooldown so a member is not re-chased every cron tick', () => {
    expect(tpl.re_enrolment_cooldown_days).toBeGreaterThan(0)
  })
})

describe('DUNNING.6 — overdue membership payment → card update reminders', () => {
  const tpl = getTemplate('overdue_payment_dunning')
  it('is a manual-trigger automation (the dunning picker + auto-enrol enrol directly), 14-day cooldown, daytime window', () => {
    expect(tpl.trigger_type).toBe('manual')
    expect(tpl.re_enrolment_cooldown_days).toBe(14)
    expect(tpl.send_window).toEqual({ start_hour: 9, end_hour: 19, skip_days: [] })
  })
  it('is wait → WhatsApp + email (1h) → email (day 3) → WhatsApp + email (day 7)', () => {
    expect(tpl.steps.map((s) => s.step_type)).toEqual(['wait', 'whatsapp', 'email', 'email', 'whatsapp', 'email'])
    expect(tpl.steps.map((s) => [s.delay_days ?? 0, s.delay_hours ?? 0])).toEqual([[0, 0], [0, 1], [0, 0], [3, 0], [4, 0], [0, 0]])
  })
  it('both WhatsApp steps use the approved utility template by NAME with the first name as {{1}}', () => {
    for (const s of tpl.steps.filter((s) => s.step_type === 'whatsapp')) {
      expect(s.whatsapp_template_name).toBe('outstanding_payment_')
      expect(s.whatsapp_variables).toEqual({ '1': 'first_name' })
    }
  })
  it('email copy is low-key: no em-dashes, no emoji, mentions updating the card', () => {
    for (const s of tpl.steps.filter((s) => s.step_type === 'email')) {
      expect(s.subject).not.toMatch(/\u2014/)
      expect(s.html_content).not.toMatch(/\u2014/)
      expect(s.html_content).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
      expect(s.html_content.toLowerCase()).toMatch(/card/)
    }
  })
})
