// MIASETTINGS.1b — the one field registry for Mia's settings (fields.js).
// Both editors render from it: the studio editor (CustomerAgentClient) and
// the organisation editor (org-fields.js → OrgDefaultsClient). These tests
// pin that no field the studio editor shows today is lost or doubled, that
// the organisation view is exactly today's, and the staff copy rules.
import { describe, it, expect } from 'vitest'
import { AGENT_FIELDS, MESSAGE_GROUPS, SECTION_KEYS, fieldsFor } from './fields'
import { ORG_FIELD_GROUPS, ORG_FIELDS } from './org-fields'
import { HATCH_COPY_FIELDS } from './hatch-copy-fields'

// Every settings path today's studio editor (CustomerAgentClient.jsx) edits:
// each setField / setFollowup / setCheckin / setInlineSuggestion path, the
// quiet-hours pair (sourceTag(['quiet_hours'])), the cancellation form block
// (setCancelForm / setCancelReason, one custom entry), the trial finisher
// block (setTrialDone, one custom entry), plus booking_flow_text (new at the
// studio, Hatch only).
const STUDIO_PATHS = [
  'enabled', 'test_mode', 'test_phones', 'booking_mode',
  'handoff_cooldown_hours', 'auto_resolve_after_reply_hours', 'auto_resolve_stale_hours',
  'effort', 'handoff_after_verify_failures', 'agent_name', 'membership_signup_url',
  'booking_url', 'booking_cta_label', 'monthly_points_target', 'social_enabled', 'membership_cta_label',
  'tone', 'extra_rules', 'holding_message',
  'booking_confirmation_text', 'cancellation_confirmation_text', 'class_move_confirmation_text',
  'comp_credits_confirmation_text', 'event_move_confirmation_text', 'event_move_failed_text',
  'booking_issue_handoff_text', 'no_credits_handoff_text', 'account_conflict_handoff_text',
  'flow_booking_ack_text', 'flow_booking_holding_text', 'flow_booking_duplicate_text', 'flow_paid_trial_text',
  'approval_decline_text', 'welcome_greeting', 'link_button_text',
  'un1t_chat_actions_enabled',
  ...HATCH_COPY_FIELDS.map((f) => f.key),
  'quiet_hours',
  'glofox_auto_cancel', 'cancellation_form',
  'followups.enabled', 'followups.nudge_after_hours', 'followups.template_name', 'followups.daily_cap',
  'first_class_checkin.enabled', 'first_class_checkin.delay_hours', 'first_class_checkin.template_name', 'first_class_checkin.daily_cap',
  'trial_done',
  'inline_suggestion.enabled',
  'booking_flow_text',
]

// Today's org-fields.js, copied before it was derived from the registry.
const ORG_GROUPS_BEFORE = [
  ['behaviour', 'Behaviour', [
    'handoff_cooldown_hours', 'auto_resolve_after_reply_hours', 'auto_resolve_stale_hours', 'effort',
    'handoff_after_verify_failures', 'agent_name', 'tone', 'extra_rules', 'quiet_hours',
  ]],
  ['messages', 'Messages to customers', [
    'holding_message', 'booking_confirmation_text', 'cancellation_confirmation_text', 'class_move_confirmation_text',
    'comp_credits_confirmation_text', 'event_move_confirmation_text', 'event_move_failed_text',
    'booking_issue_handoff_text', 'no_credits_handoff_text', 'account_conflict_handoff_text',
    'chat_booking_unavailable_text', 'booking_flow_text', 'flow_booking_ack_text', 'flow_booking_holding_text',
    'flow_booking_duplicate_text', 'flow_paid_trial_text', 'approval_decline_text', 'welcome_greeting', 'link_button_text',
  ]],
  ['hatch', 'Hatch payments and booking (un1t.online studios)', [
    'purchase_offer_intro_text', 'purchase_link_text', 'trial_used_text', 'refund_request_text',
    'purchase_link_open_text', 'purchase_paid_booked_text', 'purchase_paid_class_gone_text',
    'purchase_paid_booking_failed_text', 'purchase_paid_no_class_text', 'pay_done_page_text', 'pay_cancel_page_text',
  ]],
  ['followups', 'Proactive follow-ups', [
    'followups.enabled', 'followups.nudge_after_hours', 'followups.template_name', 'followups.daily_cap',
  ]],
  ['checkin', 'First-class check-in', [
    'first_class_checkin.enabled', 'first_class_checkin.delay_hours', 'first_class_checkin.template_name', 'first_class_checkin.daily_cap',
  ]],
  ['inline', 'Inline suggestion after approvals', ['inline_suggestion.enabled']],
]

const BRAND = { companyName: 'UN1T', shortName: 'UN1T' }
const HATCH = { membershipSourceKey: 'un1t_online', bookings: true, brand: BRAND, agentName: 'Mia' }
const GLOFOX = { membershipSourceKey: 'glofox', bookings: true, brand: BRAND, agentName: 'Mia' }

const copyOf = (f) => [
  f.label, f.help, f.placeholder, f.noneLabel,
  ...(f.options || []).map(([, label]) => label),
].filter((s) => typeof s === 'string')

describe('fields.js, the one registry', () => {
  it('every field today\'s studio editor shows is in the registry exactly once', () => {
    const paths = AGENT_FIELDS.filter((f) => f.scope !== 'org').flatMap((f) => f.paths)
    expect(new Set(paths).size).toBe(paths.length)
    expect([...paths].sort()).toEqual([...STUDIO_PATHS].sort())
  })

  it('ids are unique', () => {
    const ids = AGENT_FIELDS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('org view equals today\'s org editor', () => {
    expect(ORG_FIELDS.map((f) => f.id)).toEqual(ORG_GROUPS_BEFORE.flatMap(([, , ids]) => ids))
    expect(ORG_FIELD_GROUPS.map((g) => [g.id, g.title, g.fields.map((f) => f.id)])).toEqual(ORG_GROUPS_BEFORE)
  })

  it('every organisation field in the registry is placed in the org layout', () => {
    expect(fieldsFor('org', null, {}).map((f) => f.id).sort()).toEqual(ORG_FIELDS.map((f) => f.id).sort())
  })

  it('the org view keeps the shapes OrgDefaultsClient renders', () => {
    const kinds = new Set(['text', 'textarea', 'number', 'select', 'checkbox', 'quiet_hours'])
    for (const f of ORG_FIELDS) {
      expect(kinds.has(f.kind), f.id).toBe(true)
      expect(typeof f.label, f.id).toBe('string')
      expect(Array.isArray(f.paths), f.id).toBe(true)
      if (f.placeholder !== undefined) expect(typeof f.placeholder, f.id).toBe('string')
    }
    const byId = Object.fromEntries(ORG_FIELDS.map((f) => [f.id, f]))
    expect(byId.quiet_hours.paths).toEqual(['quiet_hours'])
    // Templates belong to each studio's number: a name at the organisation.
    expect(byId['followups.template_name']).toMatchObject({ kind: 'text', label: 'Outside-window template name' })
    expect(byId['first_class_checkin.template_name']).toMatchObject({ kind: 'text', label: 'Check-in template name' })
    // No brand at the organisation: no brand-built placeholder.
    expect(byId.holding_message.placeholder).toBeUndefined()
    expect(byId.welcome_greeting.placeholder).toBeUndefined()
    expect(byId.chat_booking_unavailable_text.label).toBe('Chat booking not available message (un1t.online studios)')
    expect(byId.tone.label).toBe('Tone and voice')
  })

  it('no em or en dash and no ampersand in any label, help, placeholder or option', () => {
    for (const ctx of [HATCH, GLOFOX]) {
      for (const scope of ['studio', 'org']) {
        for (const f of fieldsFor(scope, null, ctx)) {
          for (const s of copyOf(f)) expect(s, `${scope} ${f.id}: ${s}`).not.toMatch(/[—–&]/)
        }
      }
    }
    for (const f of ORG_FIELDS) for (const s of copyOf(f)) expect(s, f.id).not.toMatch(/[—–&]/)
    for (const g of MESSAGE_GROUPS) expect(g.title).not.toMatch(/[—–&]/)
  })

  it('no message help repeats "Leave blank to use the default shown"', () => {
    for (const f of AGENT_FIELDS.filter((x) => x.section === 'messages')) {
      expect(f.help || '', f.id).not.toMatch(/Leave blank to use the default shown/)
    }
  })

  it('every field has a known section; every messages field has a known group', () => {
    const groups = new Set(MESSAGE_GROUPS.map((g) => g.key))
    expect(SECTION_KEYS).toEqual(['overview', 'personality', 'handoffs', 'bookings', 'messages', 'followups', 'cancellation', 'knowledge', 'member-app'])
    for (const f of AGENT_FIELDS) {
      expect(SECTION_KEYS.includes(f.section), f.id).toBe(true)
      if (f.section === 'messages') expect(groups.has(f.group), f.id).toBe(true)
      else expect(f.group, f.id).toBeUndefined()
      expect(['studio', 'org', 'both'].includes(f.scope), f.id).toBe(true)
      if (f.kind === 'custom') expect(typeof f.component, f.id).toBe('string')
    }
  })

  it('the five message groups, in order', () => {
    expect(MESSAGE_GROUPS).toEqual([
      { key: 'greeting', title: 'Greeting and links' },
      { key: 'bookings', title: 'Bookings' },
      { key: 'booking-form', title: 'WhatsApp booking form' },
      { key: 'events-credits', title: 'Events and credits' },
      { key: 'hatch-payments', title: 'Payments at Hatch' },
    ])
    const ids = (group) => AGENT_FIELDS.filter((f) => f.group === group).map((f) => f.id)
    expect(ids('greeting')).toEqual(['welcome_greeting', 'link_button_text'])
    expect(ids('bookings')).toEqual([
      'booking_confirmation_text', 'cancellation_confirmation_text', 'class_move_confirmation_text',
      'booking_issue_handoff_text', 'no_credits_handoff_text', 'account_conflict_handoff_text', 'approval_decline_text',
    ])
    expect(ids('booking-form')).toEqual([
      'booking_flow_text', 'flow_booking_ack_text', 'flow_booking_holding_text', 'flow_booking_duplicate_text', 'flow_paid_trial_text',
    ])
    expect(ids('events-credits')).toEqual(['event_move_confirmation_text', 'event_move_failed_text', 'comp_credits_confirmation_text'])
    expect(ids('hatch-payments')).toEqual(HATCH_COPY_FIELDS.map((f) => f.key))
  })

  it('places each field in the section the spec gives it', () => {
    const ids = (section) => fieldsFor('studio', section, HATCH).flatMap((f) => f.paths)
    expect(ids('overview')).toEqual(['enabled', 'test_mode', 'test_phones', 'quiet_hours'])
    expect(ids('personality')).toEqual(['agent_name', 'tone', 'extra_rules', 'effort'])
    expect(ids('handoffs')).toEqual([
      'handoff_cooldown_hours', 'auto_resolve_after_reply_hours', 'auto_resolve_stale_hours',
      'handoff_after_verify_failures', 'holding_message',
    ])
    expect(ids('bookings')).toEqual([
      'booking_mode', 'membership_signup_url', 'booking_url', 'booking_cta_label', 'un1t_chat_actions_enabled',
    ])
    expect(ids('cancellation')).toEqual(['glofox_auto_cancel', 'cancellation_form'])
    expect(ids('member-app')).toEqual(['monthly_points_target', 'social_enabled', 'membership_cta_label'])
    expect(fieldsFor('studio', 'followups', HATCH).flatMap((f) => f.paths)).toEqual([
      'followups.enabled', 'followups.nudge_after_hours', 'followups.template_name', 'followups.daily_cap',
      'first_class_checkin.enabled', 'first_class_checkin.delay_hours', 'first_class_checkin.template_name', 'first_class_checkin.daily_cap',
      'trial_done', 'inline_suggestion.enabled',
    ])
    const components = fieldsFor('studio', null, HATCH).filter((f) => f.kind === 'custom').map((f) => [f.section, f.component])
    expect(components).toEqual(expect.arrayContaining([
      ['overview', 'StatusSwitch'], ['overview', 'QuietHours'], ['personality', 'Voices'], ['bookings', 'Offers'],
      ['followups', 'TemplatePicker'], ['followups', 'TrialDone'], ['cancellation', 'CancellationForm'], ['knowledge', 'Knowledge'],
    ]))
  })

  it('Hatch-only fields are absent for a Glofox ctx in studio scope and present in org scope', () => {
    const hatchOnly = ['un1t_chat_actions_enabled', 'booking_flow_text', 'offers', 'trial_done', ...HATCH_COPY_FIELDS.map((f) => f.key)]
    const glofox = new Set(fieldsFor('studio', null, GLOFOX).map((f) => f.id))
    const hatch = new Set(fieldsFor('studio', null, HATCH).map((f) => f.id))
    for (const id of hatchOnly) {
      expect(glofox.has(id), id).toBe(false)
      expect(hatch.has(id), id).toBe(true)
    }
    const org = new Set(fieldsFor('org', null, GLOFOX).map((f) => f.id))
    for (const key of ['booking_flow_text', ...HATCH_COPY_FIELDS.map((f) => f.key)]) expect(org.has(key), key).toBe(true)
    // studio-only Hatch settings never reach the organisation
    for (const id of ['un1t_chat_actions_enabled', 'offers', 'trial_done']) expect(org.has(id), id).toBe(false)
  })

  it('the booking link fields follow showBookingLink', () => {
    const has = (ctx) => fieldsFor('studio', 'bookings', ctx).map((f) => f.id)
    expect(has(GLOFOX)).not.toContain('booking_url')
    expect(has({ ...GLOFOX, bookings: false })).toEqual(expect.arrayContaining(['booking_url', 'booking_cta_label']))
    expect(has({ ...GLOFOX, bookings: null })).toEqual(expect.arrayContaining(['booking_url', 'booking_cta_label']))
    expect(has(HATCH)).toEqual(expect.arrayContaining(['booking_url', 'booking_cta_label']))
  })

  it('placeholders and labels built from ctx resolve to strings at the studio', () => {
    const byId = Object.fromEntries(fieldsFor('studio', null, { ...HATCH, brand: { companyName: 'Acme Gym', shortName: 'Acme' }, agentName: 'Zoe' }).map((f) => [f.id, f]))
    expect(byId.holding_message.placeholder).toBe('Thanks for your message! One of the Acme Gym team will get back to you shortly.')
    expect(byId.welcome_greeting.placeholder).toMatch(/I'm Zoe, the studio's assistant at Acme Gym/)
    expect(byId.monthly_points_target.label).toMatch(/^Monthly .+ target$/)
    expect(byId['followups.template_name']).toMatchObject({ kind: 'custom', component: 'TemplatePicker', label: 'Outside-window template' })
  })

  it('fieldsFor never hands back a registry entry (callers may not mutate the registry)', () => {
    const [first] = fieldsFor('studio', null, HATCH)
    expect(AGENT_FIELDS.includes(first)).toBe(false)
    expect(Object.isFrozen(AGENT_FIELDS)).toBe(true)
  })
})
