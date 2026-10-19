import { z } from 'zod'
import {
  STUDIO_ONLY_KEYS, INHERITABLE_OBJECT_KEYS, isKnownOverridePath, expandOverridden,
} from './settings-overrides'

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
  // EVENT-MOVE.7 — sent in-thread when staff approve Mia's event move
  // ({event}) or the approved move is refused ({reason}). Null → the code
  // defaults in lib/agent/notify.js.
  event_move_confirmation_text: null,
  event_move_failed_text: null,
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
  // MIAHATCH.2 — what Mia says when a member asks her to book or cancel a
  // class at a un1t.online studio (no chat booking there yet). {studio} and
  // {link} (the studio's booking_url) are filled in. Null → the code defaults
  // in lib/agent/default-copy.js, rendered by renderMiaCopy (mia-copy.js).
  chat_booking_unavailable_text: null,
  // FLOWACK.1 — the WhatsApp booking Flow's texts: the one acknowledgement a
  // class submission gets (instead of a Mia turn), and the holding line when
  // the booking goes to the team. Null → the code defaults in
  // lib/agent/default-copy.js (sent by lib/whatsapp-flow/booking-notice.js).
  // A booked Flow class is confirmed with booking_confirmation_text.
  flow_booking_ack_text: null,
  flow_booking_holding_text: null,
  // MIA-EXPIRY-QUIET.1 — booking_expired_text was RETIRED 2026-08-31. An
  // expired booking is now silent to the member (staff-push only), so there
  // is no customer copy left to edit. Stored values are ignored and dropped
  // on the next save; the key is deliberately absent, not renamed.
  // APPROVALS-STUDIO.1 — sent in-thread when staff decline a customer
  // request. Null → the code default in lib/agent/notify.js.
  approval_decline_text: null,
  // C2 — instant greeting sent when someone opens the chat without typing
  // (request_welcome). Null → code default (defaultWelcomeGreeting in
  // lib/agent/default-copy.js, built from agent_name + the location brand).
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
  // CANCEL-FORM.2 — the membership cancellation form's copy + options block.
  // Null = every code default (lib/cancellation-form/copy.js
  // CANCELLATION_FORM_DEFAULTS); the resolver merges per key so a partial
  // object only overrides what the operator actually typed.
  cancellation_form: null,
  // MIAORG.1 — where a studio WITHOUT a booking integration (Hatch Street, on
  // un1t.online) sends a customer who wants to book: Mia shares this link
  // instead of booking herself. Studio-only (an org cannot hold one link for
  // every studio). Null = no link set; Mia hands the thread to staff instead.
  booking_url: null,
  booking_cta_label: null,
  // MIAORG.1 — minutes before an unanswered handoff escalates. Read by
  // lib/agent/handoff-sla.js (resolveHandoffSlaMinutes) but never part of this
  // contract, so every editor save erased it. Null = the code default.
  handoff_sla_minutes: null,
}

// MIAORG.1 — STUDIO_ONLY_KEYS (never read from the organisation layer) and
// INHERITABLE_OBJECT_KEYS (merged per field) are defined in the zod-free
// settings-overrides.js, so the studio editor can use them without shipping
// zod to the browser. Re-exported here: one definition, the same import path.
export { STUDIO_ONLY_KEYS, INHERITABLE_OBJECT_KEYS } from './settings-overrides'

export const SettingsSchema = z.object({
  enabled: z.boolean(),
  test_mode: z.boolean().optional().default(false),
  test_phones: z.array(z.string().max(32)).max(20).optional().default([]),
  tone: z.string().max(2000).nullable().optional(),
  extra_rules: z.string().max(2000).nullable().optional(),
  holding_message: z.string().max(500).nullable().optional(),
  booking_confirmation_text: z.string().max(500).nullable().optional(),
  cancellation_confirmation_text: z.string().max(500).nullable().optional(),
  event_move_confirmation_text: z.string().max(500).nullable().optional(),
  event_move_failed_text: z.string().max(500).nullable().optional(),
  booking_issue_handoff_text: z.string().max(500).nullable().optional(),
  no_credits_handoff_text: z.string().max(500).nullable().optional(),
  account_conflict_handoff_text: z.string().max(500).nullable().optional(),
  chat_booking_unavailable_text: z.string().max(500).nullable().optional(),
  flow_booking_ack_text: z.string().max(500).nullable().optional(),
  flow_booking_holding_text: z.string().max(500).nullable().optional(),
  approval_decline_text: z.string().max(500).nullable().optional(),
  welcome_greeting: z.string().max(500).nullable().optional(),
  link_button_text: z.string().max(25).nullable().optional(),
  quiet_hours: z.object({
    start: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
    end: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
    // TZ.5 — null = the studio's own zone (locations.timezone), resolved at
    // read time (core.isWithinQuietHours). A stored zone, incl. a legacy
    // 'Europe/Dublin', is kept and still wins.
    tz: z.string().max(64).nullable().optional().default(null),
    // MIAORG.1 Task 4 (T4-A) — a STUDIO's "no quiet hours, ignore the
    // organisation's". true = start/end are ignored and Mia is never quiet
    // here (the resolver nulls them). Studio-only in effect: the resolver
    // ignores it at the org layer and the org PUT refuses it.
    off: z.boolean().nullable().optional(),
  }).superRefine((q, ctx) => {
    // Both ends, or `off`. (start and end used to be required outright.)
    if (q.off === true) return
    if (!q.start) ctx.addIssue({ code: 'custom', path: ['start'], message: 'Set both a start and an end time' })
    if (!q.end) ctx.addIssue({ code: 'custom', path: ['end'], message: 'Set both a start and an end time' })
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
  // MIAORG.1 — booking link for a studio with no booking integration. http(s)
  // only: it is sent to customers as a tappable link.
  booking_url: z.string().max(500).url()
    .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL')
    .nullable().optional()
    .or(z.literal('').transform(() => null)),
  // 20 = Meta's cta_url button text limit (display_text); the label is that button.
  booking_cta_label: z.string().max(20).nullable().optional(),
  handoff_sla_minutes: z.number().int().min(5).max(1440).nullable().optional(),
  social_enabled: z.boolean().optional().default(false),
  // CANCEL-FORM.2 — SIBLING like social_enabled: this is the
  // locations.glofox_auto_cancel_memberships COLUMN (mig 585), written by the
  // route, never into the blob. When true, approving a membership cancellation
  // executes the Glofox cancel. Ships false.
  glofox_auto_cancel: z.boolean().optional().default(false),
  cancellation_form: z.object({
    form_intro: z.string().max(1000).nullable().optional(),
    pause_offer_enabled: z.boolean().optional(),
    pause_offer_text: z.string().max(500).nullable().optional(),
    pause_max_weeks: z.number().int().min(1).max(26).nullable().optional(),
    reason_labels: z.record(z.string().max(80)).nullable().optional(),
    end_date_help_text: z.string().max(500).nullable().optional(),
    notice_days: z.number().int().min(0).max(90).nullable().optional(),
    confirm_text: z.string().max(500).nullable().optional(),
    thanks_cancel_text: z.string().max(500).nullable().optional(),
    thanks_pause_text: z.string().max(500).nullable().optional(),
    email_subject: z.string().max(200).nullable().optional(),
    email_body: z.string().max(4000).nullable().optional(),
    whatsapp_text: z.string().max(1024).nullable().optional(),
    // Meta caps cta_url display_text at 20 characters.
    whatsapp_button_text: z.string().max(20).nullable().optional(),
    whatsapp_template_name: z.string().max(512).nullable().optional(),
    cancel_confirmation_text: z.string().max(500).nullable().optional(),
    pause_confirmation_text: z.string().max(500).nullable().optional(),
    saved_confirmation_text: z.string().max(500).nullable().optional(),
    confirmation_template_cancel: z.string().max(512).nullable().optional(),
    confirmation_template_pause: z.string().max(512).nullable().optional(),
    confirmation_template_saved: z.string().max(512).nullable().optional(),
    public_base_url: z.string().url().max(512).nullable().optional()
      .or(z.literal('').transform(() => null)),
  }).nullable().optional(),
})

// CANCEL-FORM.2 — trim every string in the cancellation_form block, null the
// blanks, and drop reason labels that are blank (so the resolver falls back
// per code). Numbers and booleans pass through as validated.
function buildCancellationFormBlock(cf) {
  if (!cf || typeof cf !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(cf)) {
    if (k === 'reason_labels') {
      const labels = {}
      for (const [code, label] of Object.entries(v || {})) {
        const t = typeof label === 'string' ? label.trim() : ''
        if (t) labels[code] = t
      }
      out.reason_labels = labels
    } else if (typeof v === 'string') {
      out[k] = v.trim() || null
    } else {
      out[k] = v ?? null
    }
  }
  return out
}

// MIAORG.1 Task 4 (T4-A) — the stored quiet-hours shape: `{ off: true }`
// alone (a studio's "no quiet hours"), or the start/end/tz window with no
// `off` key (false is the same as absent, so it is never stored). Null stays
// null.
function normalizeQuietHours(q) {
  if (!q || typeof q !== 'object') return null
  if (q.off === true) return { off: true }
  const { off: _off, ...window } = q
  return window
}

/**
 * Build the object persisted at locations.settings.customer_agent from
 * validated PUT data. Pure — the route owns the DB read/merge/write.
 *
 * `social_enabled` and `glofox_auto_cancel` are deliberately NOT here: the
 * first lives top-level on locations.settings as a sibling of customer_agent,
 * the second is the locations.glofox_auto_cancel_memberships column (mig 585).
 * The route writes both separately; they are the only documented exceptions
 * to schema⊆blob.
 *
 * @param {object} data  SettingsSchema-parsed body
 * @param {{ only?: Set<string> }} [opts]  MIAORG.1 — when `only` is given, the
 *   blob holds just those keys (an override-only save: a studio stores only
 *   the fields it overrides, so inherited values are never frozen into it).
 *   Without it the full blob is built, unchanged.
 * @returns {object} the customer_agent blob
 */
export function buildCustomerAgentSettings(data = {}, { only } = {}) {
  const full = buildFullBlob(data)
  if (!only) return full
  const out = {}
  for (const k of only) if (k in full) out[k] = full[k]
  return out
}

function buildFullBlob(data) {
  return {
    enabled: data.enabled,
    test_mode: !!data.test_mode,
    test_phones: (data.test_phones || []).map((s) => s.trim()).filter(Boolean),
    tone: data.tone?.trim() || null,
    extra_rules: data.extra_rules?.trim() || null,
    holding_message: data.holding_message?.trim() || null,
    booking_confirmation_text: data.booking_confirmation_text?.trim() || null,
    cancellation_confirmation_text: data.cancellation_confirmation_text?.trim() || null,
    event_move_confirmation_text: data.event_move_confirmation_text?.trim() || null,
    event_move_failed_text: data.event_move_failed_text?.trim() || null,
    booking_issue_handoff_text: data.booking_issue_handoff_text?.trim() || null,
    no_credits_handoff_text: data.no_credits_handoff_text?.trim() || null,
    account_conflict_handoff_text: data.account_conflict_handoff_text?.trim() || null,
    chat_booking_unavailable_text: data.chat_booking_unavailable_text?.trim() || null,
    flow_booking_ack_text: data.flow_booking_ack_text?.trim() || null,
    flow_booking_holding_text: data.flow_booking_holding_text?.trim() || null,
    approval_decline_text: data.approval_decline_text?.trim() || null,
    welcome_greeting: data.welcome_greeting?.trim() || null,
    link_button_text: data.link_button_text?.trim() || null,
    quiet_hours: normalizeQuietHours(data.quiet_hours),
    limits: data.limits || null,
    booking_mode: data.booking_mode === 'draft' ? 'draft' : 'auto',
    agent_name: data.agent_name?.trim() || DEFAULTS.agent_name,
    membership_signup_url: data.membership_signup_url || null,
    membership_cta_label: data.membership_cta_label?.trim() || null,
    booking_url: data.booking_url || null,
    booking_cta_label: data.booking_cta_label?.trim() || null,
    handoff_sla_minutes: data.handoff_sla_minutes ?? null,
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
    cancellation_form: buildCancellationFormBlock(data.cancellation_form),
  }
}

// MIAORG.1 Task 3 — the studio editor's PUT names the fields the STUDIO sets
// (`overridden`); everything else is left out of the studio blob so it keeps
// inheriting from the organisation layer. Each entry is a top-level key, an
// object key's field as `<key>.<field>`, or a whole object key (shorthand for
// all of its fields). A studio-only key is accepted and changes nothing (they
// are always saved). Anything else is a 400 with the offending entry named.
export const OverriddenSchema = z.array(
  z.string().max(80).refine(isKnownOverridePath, { message: 'Unknown setting' }),
).max(200)

// The studio editor's PUT body: the settings plus an optional `overridden`.
export const StudioSettingsSchema = SettingsSchema.extend({
  overridden: OverriddenSchema.optional(),
})

/**
 * MIAORG.1 Task 3 — the blob a studio stores when its editor names what it
 * overrides. Pure; the route owns the read/merge/write.
 *
 * * Studio-only keys present in the parsed body are ALWAYS kept, whatever
 *   `overridden` says (T3-B). The parsed body carries the schema defaults
 *   for enabled / test_mode / test_phones / booking_mode, so those four are
 *   always written, exactly as the full build writes them today.
 * * An overridden top-level key is kept only when the body gives it a value
 *   (not null / blank). The full build fills some blanks with a code default
 *   (agent_name 'Mia', handoff_cooldown_hours 12, the auto-resolve windows);
 *   storing that would freeze the default over the org's value. A blank
 *   simply means "not set here", which is what null means to the resolver.
 * * An object key is stored with ONLY its overridden fields, read from the
 *   body (never buildFullBlob's filled-in object, whose frozen defaults would
 *   beat the org's values). mergeAgentSettings overlays a partial studio
 *   object field by field, so the missing fields keep inheriting.
 *
 * * An object field counts only when the client actually SENT a value for
 *   it (`sent`, the raw JSON body). The schema refuses null for the numeric
 *   fields (nudge_after_hours, daily_cap, delay_hours), so the editor omits a
 *   cleared one, and parsing then fills in the schema default. Without this
 *   check that default would be stored as the studio's override. The full
 *   (legacy) build is unaffected: it still gets the schema default, as today.
 *
 * @param {object} data  StudioSettingsSchema-parsed body
 * @param {string[]} overridden  validated override paths
 * @param {{ sent?: object }} [opts]  the raw request body; defaults to `data`
 * @returns {object} the customer_agent blob
 */
export function buildStudioOverrideBlob(data = {}, overridden = [], { sent = data } = {}) {
  const { scalars, fields } = expandOverridden(overridden)
  const only = new Set()
  for (const k of STUDIO_ONLY_KEYS) if (k in data) only.add(k)
  for (const k of scalars) {
    const v = data[k]
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) continue
    only.add(k)
  }
  const blob = buildCustomerAgentSettings(data, { only })
  for (const key of INHERITABLE_OBJECT_KEYS) {
    const wanted = fields.get(key)
    const given = data[key]
    const raw = sent && typeof sent === 'object' ? sent[key] : undefined
    if (!wanted || !given || typeof given !== 'object' || !raw || typeof raw !== 'object') continue
    const part = {}
    for (const f of wanted) {
      if (raw[f] === null || raw[f] === undefined) continue // not sent: never a schema default
      const v = given[f]
      if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) continue
      part[f] = typeof v === 'string' ? v.trim() : v
    }
    if (key === 'quiet_hours') {
      // `off: true` stands alone (the window is ignored under it); `off`
      // false is never stored (T4-A).
      if (part.off === true) { blob.quiet_hours = { off: true }; continue }
      delete part.off
    }
    if (Object.keys(part).length) blob[key] = part
  }
  return blob
}

// ── MIAORG.1 Task 4 — the ORGANISATION layer (org_settings.customer_agent) ──

// Keys an organisation can never hold: the studio-only keys, plus the two
// studio siblings the studio PUT writes elsewhere (social_enabled lives on
// locations.settings, glofox_auto_cancel is a locations column).
export const ORG_REFUSED_KEYS = new Set([...STUDIO_ONLY_KEYS, 'social_enabled', 'glofox_auto_cancel'])

// The org editor's settings: SettingsSchema minus every refused key.
export const OrgSettingsSchema = SettingsSchema.omit(
  Object.fromEntries([...ORG_REFUSED_KEYS].map((k) => [k, true])),
)

/**
 * The refusals for a raw org `settings` body, as validateBody-shaped issues
 * (empty = none). A studio-only key, and a studio's quiet-hours opt-out
 * (`quiet_hours.off`, T4-A), are 400s rather than silently dropped, so a
 * client that sends one learns it did nothing.
 * @param {object} settings  the raw body's `settings`
 * @param {string[]} [overridden]
 */
export function orgSettingsRefusals(settings, overridden = []) {
  const issues = []
  if (settings && typeof settings === 'object') {
    for (const k of Object.keys(settings)) {
      if (ORG_REFUSED_KEYS.has(k)) issues.push({ path: `settings.${k}`, message: 'Set per studio, not for the organisation' })
    }
    const q = settings.quiet_hours
    if (q && typeof q === 'object' && 'off' in q) {
      issues.push({ path: 'settings.quiet_hours.off', message: 'Only a studio can switch quiet hours off' })
    }
  }
  overridden.forEach((p, i) => {
    if (p === 'quiet_hours.off') issues.push({ path: `overridden.${i}`, message: 'Only a studio can switch quiet hours off' })
  })
  return issues
}

/**
 * The org layer an org-editor save stores: only the fields the organisation
 * sets (`overridden`), built exactly like a studio's override blob
 * (buildStudioOverrideBlob, so blanks are "not set" and a schema default is
 * never stored), with every refused key dropped and quiet hours stored as a
 * start/end pair with NO zone (T4-B: each studio reads them on its own
 * clock, locations.timezone). Null when the organisation sets nothing.
 * @param {object} data  OrgSettingsSchema-parsed settings
 * @param {string[]} overridden  validated paths the organisation sets
 * @param {{ sent?: object }} [opts]  the raw `settings` body
 * @returns {object|null}
 */
export function buildOrgLayer(data = {}, overridden = [], { sent = data } = {}) {
  const paths = overridden.filter((p) => p !== 'quiet_hours.off' && p !== 'quiet_hours.tz')
  const blob = buildStudioOverrideBlob(data, paths, { sent })
  for (const k of ORG_REFUSED_KEYS) delete blob[k]
  if (blob.quiet_hours) {
    const { start, end } = blob.quiet_hours
    if (start && end) blob.quiet_hours = { start, end }
    else delete blob.quiet_hours
  }
  return Object.keys(blob).length ? blob : null
}
