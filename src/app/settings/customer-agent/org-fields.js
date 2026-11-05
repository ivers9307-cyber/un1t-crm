// MIAORG.1 Task 4 — the fields the ORGANISATION defaults editor shows: every
// inheritable field the studio editor edits, and none of the studio-only ones
// (enabled, test mode, booking mode, the links, the cancellation form, the
// monthly points target). `limits` and `handoff_sla_minutes` have no editor
// here, as at the studio; a stored value is echoed on Save, never dropped.
//
// MIASETTINGS.1b — derived from the one registry (fields.js): labels, help,
// limits and placeholders are the registry's (the studio's wording), with
// the organisation's differences (`org` on each entry) applied by fieldsFor.
// This file only says how the organisation editor groups and orders them,
// which is unchanged.
//
// kind: text | textarea | number | select | checkbox | quiet_hours
// paths: the override paths the field sets (one, or the quiet-hours pair).

import { fieldsFor } from './fields'
import { HATCH_COPY_FIELDS, HATCH_COPY_GROUP_TITLE } from './hatch-copy-fields'

// The organisation editor's own layout: group id, title and field order.
const ORG_LAYOUT = [
  ['behaviour', 'Behaviour', [
    'handoff_cooldown_hours', 'auto_resolve_after_reply_hours', 'auto_resolve_stale_hours', 'effort',
    'handoff_after_verify_failures', 'agent_name', 'tone', 'extra_rules', 'quiet_hours',
  ]],
  ['messages', 'Messages to customers', [
    'holding_message', 'booking_confirmation_text', 'cancellation_confirmation_text', 'class_move_confirmation_text',
    'comp_credits_confirmation_text', 'event_move_confirmation_text', 'event_move_failed_text',
    'booking_issue_handoff_text', 'no_credits_handoff_text', 'account_conflict_handoff_text',
    // MIAHATCH.2 — the studio editor shows this one under Payments at Hatch.
    'chat_booking_unavailable_text',
    'booking_flow_text', 'flow_booking_ack_text', 'flow_booking_holding_text', 'flow_booking_duplicate_text',
    'flow_paid_trial_text', 'approval_decline_text', 'welcome_greeting', 'link_button_text',
  ]],
  // MIAHATCH.4 — the copy a un1t.online studio's customers see about buying
  // and paying (chat_booking_unavailable_text stays under Messages above).
  ['hatch', `${HATCH_COPY_GROUP_TITLE} (un1t.online studios)`,
    HATCH_COPY_FIELDS.map((f) => f.key).filter((k) => k !== 'chat_booking_unavailable_text')],
  ['followups', 'Proactive follow-ups', [
    'followups.enabled', 'followups.nudge_after_hours', 'followups.template_name', 'followups.daily_cap',
  ]],
  ['checkin', 'First-class check-in', [
    'first_class_checkin.enabled', 'first_class_checkin.delay_hours', 'first_class_checkin.template_name', 'first_class_checkin.daily_cap',
  ]],
  ['inline', 'Inline suggestion after approvals', ['inline_suggestion.enabled']],
]

// The shape OrgDefaultsClient renders (and settings-org reads: id, paths, label).
const ORG_KEYS = ['id', 'paths', 'kind', 'label', 'help', 'placeholder', 'maxLength', 'min', 'max', 'step', 'options']
const toOrgField = (f) => Object.fromEntries(ORG_KEYS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]))

const ORG_BY_ID = new Map(fieldsFor('org', null, {}).map((f) => [f.id, toOrgField(f)]))

function orgField(id) {
  const f = ORG_BY_ID.get(id)
  if (!f) throw new Error(`org-fields: no organisation field "${id}" in fields.js`)
  return f
}

export const ORG_FIELD_GROUPS = ORG_LAYOUT.map(([id, title, ids]) => ({ id, title, fields: ids.map(orgField) }))

export const ORG_FIELDS = ORG_FIELD_GROUPS.flatMap((g) => g.fields)

// Inheritable settings the org editor deliberately does NOT show (no editor at
// the studio either). A stored value is echoed on Save, never dropped
// (buildOrgSavePayload). A whole object key stands for all of its fields.
// org-fields.test.js pins ORG_FIELDS + this list to the inheritable catalogue,
// so a new inheritable setting fails CI until it is shown here or listed.
export const ORG_FIELDS_NOT_EDITED = Object.freeze(['handoff_sla_minutes', 'limits'])
