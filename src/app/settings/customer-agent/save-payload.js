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
    approval_decline_text: settings.approval_decline_text || null,
    welcome_greeting: settings.welcome_greeting || null,
    link_button_text: (settings.link_button_text || '').trim() || null,
    quiet_hours: settings.quiet_hours?.start && settings.quiet_hours?.end
      // TZ.5 — no zone is written when none was stored: null means the
      // studio's own zone (locations.timezone), read at decision time.
      ? { start: settings.quiet_hours.start, end: settings.quiet_hours.end, tz: settings.quiet_hours.tz || null }
      : null,
    booking_mode: settings.booking_mode === 'draft' ? 'draft' : 'auto',
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
    booking_url: settings.booking_url || null,
    booking_cta_label: settings.booking_cta_label || null,
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
  }
}
