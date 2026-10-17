// MIAORG.1 Task 2 — shared fixtures for the "no behaviour change on deploy"
// pins. Fictional values, real SHAPES.
//
// STILLORGAN_BLOB mirrors the key set of UN1T Stillorgan's live
// locations.settings.customer_agent (read 17 Oct 2026): every key it holds,
// the ones it holds as null, and NOT the ones it lacks (auto_resolve_*,
// effort, handoff_after_verify_failures, handoff_sla_minutes,
// inline_suggestion, every *_text but welcome_greeting, cancellation_form).
// The missing keys are the point: the resolver fills them from DEFAULTS (null
// or a default), where a reader used to see `undefined`.
//
// A studio with NO blob (Hatch Street) is `{}` settings.

export const STILLORGAN_BLOB = Object.freeze({
  agent_name: 'Mia - AI Agent',
  booking_cta_label: null,
  booking_mode: 'auto',
  booking_url: null,
  consultation_event_type_id: 'e0000000-0000-0000-0000-0000000000e1',
  enabled: true,
  extra_rules: 'Fictional studio rules.',
  first_class_checkin: { enabled: true, daily_cap: 20, delay_hours: 2, template_name: 'agent_first_class_checkin_v1' },
  followups: { enabled: true, daily_cap: 50, template_name: 'agent_followup', nudge_after_hours: 3 },
  handoff_cooldown_hours: 12,
  holding_message: 'Fictional holding message.',
  limits: null,
  link_button_text: null,
  membership_cta_label: null,
  membership_signup_url: null,
  monthly_points_target: 3000,
  quiet_hours: null,
  test_mode: false,
  test_phones: ['+353870000001'],
  tone: 'Fictional warm tone.',
  welcome_greeting: 'Fictional welcome.',
})

// A full org layer that tries everything: inheritable values AND every
// studio-only key switched on, so a test can prove the studio-only ones never
// land.
export const ORG_LAYER = Object.freeze({
  enabled: true,
  test_mode: true,
  test_phones: ['+353870000099'],
  tone: 'Org tone.',
  extra_rules: 'Org rules.',
  agent_name: 'Org Mia',
  welcome_greeting: 'Org welcome.',
  holding_message: 'Org holding.',
  booking_confirmation_text: 'Org booked {class}.',
  cancellation_confirmation_text: 'Org cancelled {class}.',
  approval_decline_text: 'Org decline.',
  event_move_confirmation_text: 'Org moved {event}.',
  event_move_failed_text: 'Org move failed: {reason}.',
  monthly_points_target: 4500,
  handoff_sla_minutes: 30,
  inline_suggestion: { enabled: false },
  followups: { enabled: true, template_name: 'org_followup' },
  first_class_checkin: { enabled: true, template_name: 'org_checkin' },
  membership_signup_url: 'https://org.example.test/join',
  membership_cta_label: 'Org join',
  cancellation_form: { form_intro: 'Org intro.' },
  booking_url: 'https://org.example.test/book',
})

/**
 * A minimal `db` for resolveAgentSettings / resolveAgentSettingsForLocation:
 * `org_settings` answers `{ customer_agent: org }` (org null = no layer).
 * Wrap another fake: every other table goes to `inner.from`.
 */
export function withOrgLayer(inner, org) {
  return {
    ...inner,
    from(table) {
      if (table !== 'org_settings') return inner.from(table)
      const result = { data: org == null ? null : { customer_agent: org }, error: null }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(result),
        then: (res, rej) => Promise.resolve(result).then(res, rej),
      }
      return chain
    },
  }
}
