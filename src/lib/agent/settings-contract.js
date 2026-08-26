import { z } from 'zod'

// MIA-HYGIENE.1 — the customer-agent settings CONTRACT, extracted from the
// settings route so the schema, the defaults and the persisted-object builder
// live together and can be unit-tested as one unit.
//
// WHY THIS FILE EXISTS: the PUT used to build its persisted object
// field-by-field, inline. Twice that dropped a validated key on the floor —
// #495 (followups / first_class_checkin / agent_name / handoff_cooldown_hours
// were zod-validated but never WRITTEN, so the UI said "Saved ✓" while the
// value vanished; Mia introduced herself UNNAMED in prod for weeks), and again
// in the 2026-08-19 audit (`effort` and `handoff_after_verify_failures` are
// read on every live turn but never appeared in the schema or the editor, so
// EFFORT.1's operator tuning was unreachable without hand-editing JSONB).
//
// buildCustomerAgentSettings is the single writer, and
// settings-contract.test.js asserts every SettingsSchema key survives into its
// output. Add a key to the schema without adding it here and CI fails —
// which is the point.

export const DEFAULTS = {
  enabled: false,
  test_mode: false,
  test_phones: [],
  tone: null,
  extra_rules: null,
  holding_message: null,
  // AGENT-HANDS.1 / AGENT-CANCEL.1 — the in-thread texts sent to the customer
  // when staff approve a drafted booking / cancellation. Null → the code
  // defaults in lib/agent/notify.js. {class} renders the class + time.
  booking_confirmation_text: null,
  cancellation_confirmation_text: null,
  // MIA-BOOK.1 — what the agent tells the customer when Glofox rejects a
  // booking (e.g. no credits) and the attempt becomes a pending approval.
  // Null → the code default in lib/agent/notify.js.
  booking_issue_handoff_text: null,
  // MIA-CREDITS.1 — sent verbatim when the booking pre-flight finds no
  // usable balance and the thread hands off to a human. Null → the code
  // default in lib/agent/core.js (DEFAULT_NO_CREDITS_HANDOFF_TEXT).
  no_credits_handoff_text: null,
  // PERSON-ACCT.7 — sent verbatim when the booking tool finds two live
  // accounts for the same person and hands off rather than guessing. Null →
  // the code default in lib/agent/core.js
  // (DEFAULT_ACCOUNT_CONFLICT_HANDOFF_TEXT).
  account_conflict_handoff_text: null,
  // MIA-BOARD.2 — apology when a pending booking outlives its class. Null →
  // DEFAULT_BOOKING_EXPIRED_TEXT in lib/agent/notify.js.
  booking_expired_text: null,
  // APPROVALS-STUDIO.1 — sent in-thread when staff decline a customer
  // request. Null → the code default in lib/agent/notify.js.
  approval_decline_text: null,
  // C2 — instant greeting sent when someone opens the chat without typing
  // (request_welcome). Null → code default (DEFAULT_WELCOME_GREETING).
  welcome_greeting: null,
  // C3 — label on the tappable button of cta_url link messages.
  // Null → code default ('Open link').
  link_button_text: null,
  quiet_hours: null,
  limits: null,
  monthly_points_target: null,
  // AGENT-HANDS.1 — class-booking autonomy. 'auto' (default) books a
  // verified member's class immediately; 'draft' queues it for a
  // one-tap staff approval (which executes it). Consultations are
  // always autonomous. consultation_event_type_id optionally pins the
  // consultation booking type (otherwise name-matched consult/intro/
  // taster).
  booking_mode: 'auto',
  agent_name: 'Mia',
  membership_signup_url: null,
  membership_cta_label: null,
  followups: { enabled: false, nudge_after_hours: 3, template_name: null, daily_cap: 50 },
  first_class_checkin: { enabled: false, delay_hours: 2, template_name: null, daily_cap: 20 },
  // INBOX-APPROVALS-AI.4 — Wave 3 inline suggestion after approvals.
  // Absent/enabled-undefined means ON (the suggest route only treats an
  // explicit `enabled === false` as off); default true here matches that.
  inline_suggestion: { enabled: true },
  handoff_cooldown_hours: 12,
  // MIA-BOARD.1 — handoff auto-resolve windows (hours). (a) human replied
  // then quiet, (b) fully stale. 0 disables a case. Defaults are Richard's
  // 2026-08-20 decision (8h/48h); the sweep clamps again at read time
  // (resolveAutoResolveHours, handoff-sla.js).
  auto_resolve_after_reply_hours: 8,
  auto_resolve_stale_hours: 48,
  consultation_event_type_id: null,
  // MIA-HYGIENE.1 — null means "use the code default". The live defaults are
  // owned by lib/agent/core.js (DEFAULT_AGENT_EFFORT = 'medium',
  // VERIFY_FAIL_HANDOFF_DEFAULT = 2) and resolved per turn, so a null here
  // stays honest about what is actually configured rather than duplicating
  // the constant in two places.
  effort: null,
  handoff_after_verify_failures: null,
}

export const SettingsSchema = z.object({
  enabled: z.boolean(),
  test_mode: z.boolean().optional().default(false),
  test_phones: z.array(z.string().max(32)).max(20).optional().default([]),
  tone: z.string().max(2000).nullable().optional(),
  extra_rules: z.string().max(2000).nullable().optional(),
  holding_message: z.string().max(500).nullable().optional(),
  booking_confirmation_text: z.string().max(500).nullable().optional(),
  cancellation_confirmation_text: z.string().max(500).nullable().optional(),
  booking_issue_handoff_text: z.string().max(500).nullable().optional(),
  no_credits_handoff_text: z.string().max(500).nullable().optional(),
  account_conflict_handoff_text: z.string().max(500).nullable().optional(),
  booking_expired_text: z.string().max(500).nullable().optional(),
  approval_decline_text: z.string().max(500).nullable().optional(),
  welcome_greeting: z.string().max(500).nullable().optional(),
  link_button_text: z.string().max(25).nullable().optional(),
  quiet_hours: z.object({
    start: z.string().regex(/^\d{1,2}:\d{2}$/),
    end: z.string().regex(/^\d{1,2}:\d{2}$/),
    tz: z.string().max(64).optional().default('Europe/Dublin'),
  }).nullable().optional(),
  // Cost/abuse ceilings. Omitted → code defaults (20/conv/hr, 500/loc/day).
  limits: z.object({
    max_replies_per_conversation_per_hour: z.number().int().min(1).max(1000).optional(),
    max_replies_per_location_per_day: z.number().int().min(1).max(100000).optional(),
  }).nullable().optional(),
  booking_mode: z.enum(['auto', 'draft']).optional().default('auto'),
  agent_name: z.string().max(40).nullable().optional(),
  membership_signup_url: z.string().url().max(512).nullable().optional()
    .or(z.literal('').transform(() => null)),
  membership_cta_label: z.string().max(60).nullable().optional(),
  followups: z.object({
    enabled: z.boolean().optional().default(false),
    nudge_after_hours: z.number().min(1).max(18).optional().default(3),
    template_name: z.string().max(512).nullable().optional(),
    daily_cap: z.number().min(1).max(500).optional().default(50),
  }).nullable().optional(),
  first_class_checkin: z.object({
    enabled: z.boolean().optional().default(false),
    delay_hours: z.number().min(1).max(24).optional().default(2),
    template_name: z.string().max(512).nullable().optional(),
    daily_cap: z.number().min(1).max(200).optional().default(20),
  }).nullable().optional(),
  inline_suggestion: z.object({
    enabled: z.boolean().optional().default(true),
  }).nullable().optional(),
  handoff_cooldown_hours: z.number().min(0).max(168).nullable().optional(),
  auto_resolve_after_reply_hours: z.number().min(0).max(720).nullable().optional(),
  auto_resolve_stale_hours: z.number().min(0).max(720).nullable().optional(),
  consultation_event_type_id: z.string().max(64).nullable().optional(),
  monthly_points_target: z.number().int().min(0).nullable().optional(),
  // MIA-HYGIENE.1 — reasoning effort for the inbound reply. Clamped again at
  // read time by resolveAgentEffort (core.js); the enum here matches
  // AGENT_EFFORT_LEVELS so the editor can never persist a value the Messages
  // API would 400 on.
  effort: z.enum(['low', 'medium', 'high', 'max']).nullable().optional(),
  // MIA-HYGIENE.1 — consecutive failed identity quizzes before Mia hands the
  // thread to a human (AGENT-VERIFY-HANDOFF.1). Bounded so a typo can't
  // effectively disable the safety net by setting it to 500.
  handoff_after_verify_failures: z.number().int().min(1).max(5).nullable().optional(),
  social_enabled: z.boolean().optional().default(false),
})

/**
 * Build the object persisted at locations.settings.customer_agent from
 * validated PUT data. Pure — the route owns the DB read/merge/write.
 *
 * `social_enabled` is deliberately NOT here: it lives top-level on
 * locations.settings as a sibling of customer_agent, and the route writes it
 * separately. It is the only documented exception to schema⊆blob.
 *
 * @param {object} data  SettingsSchema-parsed body
 * @returns {object} the customer_agent blob
 */
export function buildCustomerAgentSettings(data = {}) {
  return {
    enabled: data.enabled,
    test_mode: !!data.test_mode,
    test_phones: (data.test_phones || []).map((s) => s.trim()).filter(Boolean),
    tone: data.tone?.trim() || null,
    extra_rules: data.extra_rules?.trim() || null,
    holding_message: data.holding_message?.trim() || null,
    booking_confirmation_text: data.booking_confirmation_text?.trim() || null,
    cancellation_confirmation_text: data.cancellation_confirmation_text?.trim() || null,
    booking_issue_handoff_text: data.booking_issue_handoff_text?.trim() || null,
    no_credits_handoff_text: data.no_credits_handoff_text?.trim() || null,
    account_conflict_handoff_text: data.account_conflict_handoff_text?.trim() || null,
    booking_expired_text: data.booking_expired_text?.trim() || null,
    approval_decline_text: data.approval_decline_text?.trim() || null,
    welcome_greeting: data.welcome_greeting?.trim() || null,
    link_button_text: data.link_button_text?.trim() || null,
    quiet_hours: data.quiet_hours || null,
    limits: data.limits || null,
    booking_mode: data.booking_mode === 'draft' ? 'draft' : 'auto',
    agent_name: data.agent_name?.trim() || DEFAULTS.agent_name,
    membership_signup_url: data.membership_signup_url || null,
    membership_cta_label: data.membership_cta_label?.trim() || null,
    handoff_cooldown_hours: data.handoff_cooldown_hours ?? DEFAULTS.handoff_cooldown_hours,
    auto_resolve_after_reply_hours: data.auto_resolve_after_reply_hours ?? DEFAULTS.auto_resolve_after_reply_hours,
    auto_resolve_stale_hours: data.auto_resolve_stale_hours ?? DEFAULTS.auto_resolve_stale_hours,
    followups: { ...DEFAULTS.followups, ...(data.followups || {}) },
    first_class_checkin: { ...DEFAULTS.first_class_checkin, ...(data.first_class_checkin || {}) },
    inline_suggestion: { ...DEFAULTS.inline_suggestion, ...(data.inline_suggestion || {}) },
    consultation_event_type_id: data.consultation_event_type_id || null,
    monthly_points_target: data.monthly_points_target ?? null,
    effort: data.effort || null,
    handoff_after_verify_failures: data.handoff_after_verify_failures ?? null,
  }
}
