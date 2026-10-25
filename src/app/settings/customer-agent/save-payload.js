// MIAORG.1 Task 3 — the studio editor's PUT body, built from what the editor
// shows. Pure, so a test can run the REAL payload (the Stillorgan round trip,
// save-payload.test.js) rather than a copy of it.
//
// A cleared field is "not stored", never a code default: it is sent as null
// where the schema takes null (top-level numbers), and omitted where it does
// not (the follow-up / check-in numbers, which refuse null; the PUT keeps an
// object field only when it was sent). A 0 the operator typed is sent as 0.
// The PUT stores only `overridden` plus the studio-only keys; a body WITHOUT
// `overridden` (an older editor) still gets today's code defaults server-side.

import { HATCH_COPY_FIELDS } from './hatch-copy-fields'

// Echo the whole cancellation-form block back exactly as edited: strings as
// typed (the contract trims/nulls blanks), numbers as numbers, the toggle as a
// boolean, reason labels per code. Null when the operator has never touched it.
export function buildCancellationFormPayload(cf) {
  if (!cf || typeof cf !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(cf)) {
    if (k === 'reason_labels') {
      out.reason_labels = Object.fromEntries(Object.entries(v || {}).filter(([, l]) => typeof l === 'string'))
    } else if (k === 'pause_offer_enabled') {
      out[k] = v !== false
    } else if (k === 'pause_max_weeks' || k === 'notice_days') {
      out[k] = v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v)
    } else {
      out[k] = typeof v === 'string' ? v : (v ?? null)
    }
  }
  return out
}

// Drop the unset fields of an object (the schema refuses a null limit).
export function compactObject(o) {
  if (!o || typeof o !== 'object') return null
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined))
  return Object.keys(out).length ? out : null
}

// A number field's value: null when cleared (blank, null, not a number), else
// the number as typed, 0 included.
export function numberOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

// An object's number field: as typed, or left out (undefined) when cleared,
// since the schema refuses null there.
const numberOrOmit = (v) => numberOrNull(v) ?? undefined

// TRIALDONE.3 — the trial-finisher block (studio-only). The editor holds the
// test-contact list as free text (`only_contact_ids_text`) so a newline can be
// typed; the body carries the parsed ids. Fields the operator cleared are left
// OUT (the schema refuses null), so the default fills in. Limits mirror
// SettingsSchema.trial_done (settings-contract.js), kept here so this client
// file stays zod-free.
const TRIAL_DONE_HOUR_FIELDS = ['delay_hours', 'stale_after_hours', 'followup_after_hours', 'followup_max_hours', 'nudge_after_hours', 'nudge_max_hours']
const TRIAL_DONE_TEMPLATE_FIELDS = ['opener_template', 'followup_template']
const TRIAL_DONE_TEMPLATE_SHAPE = /^[a-z0-9_]{1,512}$/
const TRIAL_DONE_ID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export const TRIAL_DONE_IDS_MAX = 20
export const TRIAL_DONE_INSTRUCTION_MAX = 1000
export const TRIAL_DONE_TEMPLATE_ERROR = 'Use lowercase letters, numbers and underscores only.'
export const TRIAL_DONE_DASH_ERROR = 'No em-dashes in customer messages.'

const trimmedOrOmit = (v) => (typeof v === 'string' ? v.trim() : '') || undefined

// The ids typed into the test-contact box (spaces, commas or lines), de-duplicated.
export function parseTrialDoneContactIds(text) {
  return [...new Set(String(text ?? '').split(/[\s,;]+/).filter(Boolean))]
}

function trialDoneIds(td) {
  if (typeof td.only_contact_ids_text === 'string') return parseTrialDoneContactIds(td.only_contact_ids_text)
  return Array.isArray(td.only_contact_ids) ? td.only_contact_ids : []
}

/** The PUT body's `trial_done`, or undefined when the editor holds no block (nothing is written). */
export function buildTrialDonePayload(td) {
  if (!td || typeof td !== 'object') return undefined
  const out = { enabled: td.enabled === true }
  for (const f of TRIAL_DONE_HOUR_FIELDS) out[f] = numberOrOmit(td[f])
  for (const f of TRIAL_DONE_TEMPLATE_FIELDS) out[f] = trimmedOrOmit(td[f])
  out.daily_cap = numberOrOmit(td.daily_cap)
  out.only_contact_ids = trialDoneIds(td)
  out.mia_instruction = trimmedOrOmit(td.mia_instruction)
  return out
}

/** What the PUT would refuse in the trial-finisher block, as inline messages (staff copy). */
export function trialDoneErrors(settings) {
  const td = settings?.trial_done
  const errors = {}
  if (!td || typeof td !== 'object') return errors
  for (const f of TRIAL_DONE_HOUR_FIELDS) {
    const n = numberOrNull(td[f])
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 72)) errors[f] = 'A whole number from 1 to 72.'
  }
  const cap = numberOrNull(td.daily_cap)
  if (cap !== null && !(Number.isInteger(cap) && cap >= 1 && cap <= 200)) errors.daily_cap = 'A whole number from 1 to 200.'
  for (const f of TRIAL_DONE_TEMPLATE_FIELDS) {
    const v = typeof td[f] === 'string' ? td[f].trim() : ''
    if (v && !TRIAL_DONE_TEMPLATE_SHAPE.test(v)) errors[f] = TRIAL_DONE_TEMPLATE_ERROR
  }
  const instruction = typeof td.mia_instruction === 'string' ? td.mia_instruction : ''
  if (instruction.includes('\u2014')) errors.mia_instruction = TRIAL_DONE_DASH_ERROR
  else if (instruction.trim().length > TRIAL_DONE_INSTRUCTION_MAX) errors.mia_instruction = `At most ${TRIAL_DONE_INSTRUCTION_MAX} characters.`
  const ids = trialDoneIds(td)
  if (ids.some((id) => !TRIAL_DONE_ID_SHAPE.test(id))) errors.only_contact_ids = 'Each id must be a 36-character contact id.'
  else if (ids.length > TRIAL_DONE_IDS_MAX) errors.only_contact_ids = `At most ${TRIAL_DONE_IDS_MAX} contacts.`
  return errors
}

// MIAORG.1 Task 4 (T4-A) — `{ off: true }` is a studio's "no quiet hours
// (ignore the organisation's)": the window is not sent with it. Otherwise
// both ends or nothing. TZ.5 — no zone is written when none was stored: null
// means the studio's own zone (locations.timezone), read at decision time.
export function buildQuietHoursPayload(q) {
  if (q?.off === true) return { off: true }
  return q?.start && q?.end ? { start: q.start, end: q.end, tz: q.tz || null } : null
}

/**
 * @param {object} settings  the editor's state (the resolved settings, as edited)
 * @param {string[]} overridden  the fields this studio sets itself
 * @returns {object} the PUT body
 */
export function buildSavePayload(settings, overridden) {
  return {
    // Only these (plus the studio-only keys) are stored.
    overridden,
    enabled: !!settings.enabled,
    test_mode: !!settings.test_mode,
    test_phones: (settings.test_phones || []),
    tone: settings.tone || null,
    extra_rules: settings.extra_rules || null,
    holding_message: settings.holding_message || null,
    booking_confirmation_text: settings.booking_confirmation_text || null,
    cancellation_confirmation_text: settings.cancellation_confirmation_text || null,
    event_move_confirmation_text: settings.event_move_confirmation_text || null,
    event_move_failed_text: settings.event_move_failed_text || null,
    booking_issue_handoff_text: settings.booking_issue_handoff_text || null,
    no_credits_handoff_text: settings.no_credits_handoff_text || null,
    account_conflict_handoff_text: settings.account_conflict_handoff_text || null,
    // MIAHATCH.4 — the Hatch booking and payment copy (a blank is null: the code default).
    ...Object.fromEntries(HATCH_COPY_FIELDS.map(({ key }) => [key, (settings[key] || '').trim() || null])),
    approval_decline_text: settings.approval_decline_text || null,
    // FLOWACK.1 — the WhatsApp booking Flow's acknowledgement + holding line.
    flow_booking_ack_text: settings.flow_booking_ack_text || null,
    flow_booking_holding_text: settings.flow_booking_holding_text || null,
    flow_booking_duplicate_text: settings.flow_booking_duplicate_text || null,
    welcome_greeting: settings.welcome_greeting || null,
    link_button_text: (settings.link_button_text || '').trim() || null,
    quiet_hours: buildQuietHoursPayload(settings.quiet_hours),
    booking_mode: settings.booking_mode === 'draft' ? 'draft' : 'auto',
    // MIAHATCH.5 — studio-only, always saved (the Hatch group's switch). Only a
    // real true turns it on.
    un1t_chat_actions_enabled: settings.un1t_chat_actions_enabled === true,
    agent_name: (settings.agent_name || '').trim() || null,
    membership_signup_url: (settings.membership_signup_url || '').trim() || null,
    membership_cta_label: (settings.membership_cta_label || '').trim() || null,
    // Null = not set here (the PUT stores nothing; a legacy full save still
    // writes the code default). 0 is a real value (0 = only a resolve / off).
    handoff_cooldown_hours: numberOrNull(settings.handoff_cooldown_hours),
    // MIA-BOARD.1 — handoff auto-resolve windows (0 disables a case).
    auto_resolve_after_reply_hours: numberOrNull(settings.auto_resolve_after_reply_hours),
    auto_resolve_stale_hours: numberOrNull(settings.auto_resolve_stale_hours),
    // MIA-HYGIENE.1 — both were read live by the agent but had no editor,
    // so they sat permanently on their code defaults. Null = "use default".
    effort: settings.effort || null,
    handoff_after_verify_failures: numberOrNull(settings.handoff_after_verify_failures),
    consultation_event_type_id: settings.consultation_event_type_id || null,
    monthly_points_target: numberOrNull(settings.monthly_points_target),
    // MIAORG.1 — no editor here yet; echoed so a Save never erases them
    // (handoff_sla_minutes used to be dropped by every save).
    limits: compactObject(settings.limits),
    handoff_sla_minutes: numberOrNull(settings.handoff_sla_minutes),
    // MIAORG.1 — studio-only, always saved (the studio editor's Booking link
    // fields). A blank link or label is null: Mia then hands bookings to the
    // team / uses the default button text.
    booking_url: (settings.booking_url || '').trim() || null,
    booking_cta_label: (settings.booking_cta_label || '').trim() || null,
    social_enabled: !!settings.social_enabled,
    // CANCEL-FORM.2 — the toggle is a locations COLUMN (sibling, like
    // social_enabled); the block MUST be echoed whole, because the PUT
    // rebuilds the customer_agent blob and an omitted key resets it.
    glofox_auto_cancel: !!settings.glofox_auto_cancel,
    cancellation_form: buildCancellationFormPayload(settings.cancellation_form),
    followups: {
      enabled: !!settings.followups?.enabled,
      nudge_after_hours: numberOrOmit(settings.followups?.nudge_after_hours),
      template_name: settings.followups?.template_name || null,
      daily_cap: numberOrOmit(settings.followups?.daily_cap),
    },
    first_class_checkin: {
      enabled: !!settings.first_class_checkin?.enabled,
      delay_hours: numberOrOmit(settings.first_class_checkin?.delay_hours),
      template_name: settings.first_class_checkin?.template_name || null,
      daily_cap: numberOrOmit(settings.first_class_checkin?.daily_cap),
    },
    inline_suggestion: {
      enabled: settings.inline_suggestion?.enabled !== false,
    },
    // TRIALDONE.3 — studio-only, always saved (undefined = no block held, so
    // JSON drops it and nothing is written over a stored one).
    trial_done: buildTrialDonePayload(settings.trial_done),
  }
}

// MIAORG.1 Task 4 — keys the ORG editor never sends (the PUT refuses them):
// the studio-only keys and the two studio siblings. Kept in step with
// ORG_REFUSED_KEYS in settings-contract.js (pinned by save-payload.test.js);
// listed here so this client file stays zod-free.
export const ORG_PAYLOAD_DROPPED_KEYS = Object.freeze([
  'enabled', 'test_mode', 'test_phones', 'consultation_event_type_id', 'booking_mode', 'cancellation_form',
  'booking_url', 'booking_cta_label', 'membership_signup_url', 'membership_cta_label', 'monthly_points_target',
  'un1t_chat_actions_enabled', 'trial_done', 'social_enabled', 'glofox_auto_cancel',
])

/**
 * MIAORG.1 Task 4 — the org editor's PUT body: the same number and blank
 * rules as the studio editor (buildSavePayload), minus every key an
 * organisation cannot hold. Quiet hours go as a start/end pair with no zone
 * (T4-B: each studio reads them on its own clock) and never as `off`.
 * @param {object} values  the org editor's state (the org layer over the defaults, as edited)
 * @param {string[]} set   the paths the organisation sets
 * @param {string} organizationId
 */
export function buildOrgSavePayload(values, set, organizationId) {
  const { overridden: _o, ...full } = buildSavePayload(values || {}, set)
  for (const k of ORG_PAYLOAD_DROPPED_KEYS) delete full[k]
  const q = values?.quiet_hours
  full.quiet_hours = q?.start && q?.end ? { start: q.start, end: q.end, tz: null } : null
  return {
    organization_id: organizationId,
    settings: full,
    overridden: (set || []).filter((p) => p !== 'quiet_hours.off' && p !== 'quiet_hours.tz'),
  }
}

// MIAORG.1 final review — the studio editor's Booking link fields, checked as
// the PUT checks them (SettingsSchema: booking_url an http(s) URL of at most
// 500 characters, booking_cta_label at most 20, Meta's button text limit), so
// the operator sees what is wrong beside the field before saving. Blank is
// fine (null: no link). Staff copy.
export const BOOKING_CTA_LABEL_MAX = 20
export const BOOKING_URL_ERROR = 'Enter a full link starting with https:// (or http://).'

export function bookingLinkErrors(settings) {
  const errors = {}
  const url = String(settings?.booking_url ?? '').trim()
  if (url) {
    let ok = /^https?:\/\/\S+$/i.test(url) && url.length <= 500
    if (ok) { try { ok = !!new URL(url).hostname } catch { ok = false } }
    if (!ok) errors.booking_url = BOOKING_URL_ERROR
  }
  const label = String(settings?.booking_cta_label ?? '').trim()
  if (label.length > BOOKING_CTA_LABEL_MAX) errors.booking_cta_label = `At most ${BOOKING_CTA_LABEL_MAX} characters.`
  return errors
}

// The PUT's 400 issues for the two booking fields, as inline messages (the
// URL's own issue is zod's generic "Invalid input" from the union, so it is
// worded here).
export function bookingIssuesFromResponse(issues) {
  const out = {}
  for (const i of Array.isArray(issues) ? issues : []) {
    const path = String(i?.path || '')
    if (path === 'booking_url' || path.startsWith('booking_url.')) out.booking_url = BOOKING_URL_ERROR
    else if (path === 'booking_cta_label' || path.startsWith('booking_cta_label.')) out.booking_cta_label = i?.message || `At most ${BOOKING_CTA_LABEL_MAX} characters.`
  }
  return out
}
