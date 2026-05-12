// PIPELINE5.2 — engagement-aware pipeline classifier.
//
// Single pure function that maps a contact's (Glofox status,
// engagement signal, recency) to a pipeline_stages.slug. Replaces
// the simpler GLOFOX_STATUS_TO_STAGE_SLUG map in glofox-sync.js,
// which was a 1:1 status→stage mapping that didn't account for
// staleness — operators ended up with 8k pipeline ghosts after
// the bulk import.
//
// Stage definitions (final, signed off by operator on 2026-05-12):
//
//   new_lead         — status in {lead, cold, tour}; joined < 90d
//                      ago; never attended
//   active_trial     — status='trial'; attended in last 30d OR
//                      joined < 14d ago (still in trial window)
//   hot_conversion   — trial / tour / no_sale_trial AND
//                        (≥2 classes in last 7d
//                         OR trial_credits_remaining ≤ 1)
//   active_member    — status in {member, credit_member}; attended
//                      in last 30d OR paid in last 60d
//   at_risk_member   — status in {member, credit_member}; no booking
//                      in 30-90d AND no payment in last 60d
//   classpass_active — status='classpass_payg'; attended in last 30d
//   lapsed           — was active in last 6mo, now 60-180d idle
//   dormant          — 180+ days idle, non-ClassPass; OR no
//                      engagement signal at all
//   dormant_classpass— classpass_payg WITHOUT attendance in last 30d
//
// Pure function — input → output, no side effects. The caller (the
// nightly cron and applyMemberSync) feeds it a snapshot and writes
// the result to deals.stage_id. Idempotent — same input always
// produces same output.
//
// Tests in pipeline-classifier.test.js cover every branch with
// concrete fixtures (Paula, Andrew, Sarah, etc.).

const DAY_MS = 24 * 60 * 60 * 1000

// Tuneable thresholds. Centralised so the operator can tweak by
// editing one block without grepping the codebase. Times are in
// days, counts are bookings.
export const PIPELINE_THRESHOLDS = {
  // "Hot Conversion" signal — the GLOFOX4.2 trial-transition tags
  // use the same numbers so the classifier and the sequence
  // triggers stay aligned.
  HOT_RECENT_DAYS:           7,
  HOT_MIN_ATTENDED:          2,
  HOT_CREDITS_REMAINING_MAX: 1,

  // "Active" engagement window — recent enough to count as
  // currently using the studio.
  ACTIVE_RECENT_DAYS:        30,

  // "At Risk" warning window for paying members — booked at some
  // point but gone quiet. Don't go further than this before
  // classifying as lapsed.
  AT_RISK_MAX_DAYS:          90,

  // Payment recency to keep someone in Active Member when they
  // pay but rarely attend (subscription-style members).
  ACTIVE_PAID_RECENT_DAYS:   60,

  // "Lapsed" — was a member or trial, gone quiet for a while but
  // still close enough that re-engagement is realistic. The lower
  // bound is the boundary AFTER active+at_risk so a paying member
  // with 91d silence rolls cleanly from at_risk → lapsed at day
  // 91, and a non-member who attended exactly 60d ago lands in
  // lapsed straight away.
  LAPSED_MIN_DAYS:           60,
  LAPSED_MAX_DAYS:           180,

  // New Lead window — joined recently enough to be considered
  // top-of-funnel. After this they go to dormant unless they've
  // shown engagement.
  NEW_LEAD_RECENT_DAYS:      90,

  // Active Trial — trial members who JUST joined are active even
  // before their first class.
  TRIAL_GRACE_DAYS:          14,
}

// Helper: number of days between two ISO timestamps. Returns null
// when either is missing.
function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  return ms / DAY_MS
}

/**
 * Classify a contact into a pipeline stage based on their current
 * (Glofox status × engagement × recency).
 *
 * @param {object} contact
 * @param {string|null} contact.glofox_membership_status
 * @param {string|null} contact.last_attended_at      ISO timestamp
 * @param {number|null} contact.total_attended_7d
 * @param {number|null} contact.total_attended_30d
 * @param {string|null} contact.last_payment_at       ISO timestamp
 * @param {string|null} contact.joined_at             ISO timestamp
 * @param {string|null} contact.created_at            ISO timestamp (CRM)
 * @param {number|null} contact.trial_credits_remaining
 * @param {number}      [now=Date.now()]              for tests
 * @returns {string}  pipeline_stages.slug
 */
export function classifyContact(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return 'dormant'

  const status = contact.glofox_membership_status || null
  const credits = Number.isFinite(contact.trial_credits_remaining)
    ? contact.trial_credits_remaining
    : null

  const daysSinceAttended = daysSince(contact.last_attended_at, now)
  const daysSincePaid     = daysSince(contact.last_payment_at, now)
  const daysSinceJoined   = daysSince(contact.joined_at, now)
  const daysSinceCreated  = daysSince(contact.created_at, now)
  const attended7d  = Number.isFinite(contact.total_attended_7d)  ? contact.total_attended_7d  : 0
  // total_attended_30d is read separately by the active checks below
  // (via the recentlyAttended derived flag, which uses
  // last_attended_at). Not surfaced here to avoid an unused warning.

  const recentlyAttended = daysSinceAttended !== null && daysSinceAttended <= PIPELINE_THRESHOLDS.ACTIVE_RECENT_DAYS
  const recentlyPaid     = daysSincePaid !== null && daysSincePaid <= PIPELINE_THRESHOLDS.ACTIVE_PAID_RECENT_DAYS
  const lapsedWindow     = daysSinceAttended !== null
    && daysSinceAttended >= PIPELINE_THRESHOLDS.LAPSED_MIN_DAYS
    && daysSinceAttended <= PIPELINE_THRESHOLDS.LAPSED_MAX_DAYS

  // ── ClassPass ────────────────────────────────────────────────
  // ClassPass users always go to one of two ClassPass-specific
  // buckets — they're a distinct sales motion from UN1T
  // memberships. Operator's call: only show actively-attending
  // ClassPass users in the visible pipeline; older ones move to
  // a dormant ClassPass archive.
  if (status === 'classpass_payg') {
    return recentlyAttended ? 'classpass_active' : 'dormant_classpass'
  }

  // ── Hot Conversion (signal-driven) ──────────────────────────
  // Fires regardless of trial vs tour vs no_sale_trial as long as
  // the engagement signal is strong. The credits threshold
  // catches "used 2 of 3 trial credits, about to convert OR
  // about to lose them" — the exact GLOFOX4.2 signal the
  // trial-pipeline templates listen for.
  const isHotCandidateStatus = (
    status === 'trial' || status === 'tour' || status === 'no_sale_trial'
  )
  if (isHotCandidateStatus) {
    const meetsAttendBar =
      attended7d >= PIPELINE_THRESHOLDS.HOT_MIN_ATTENDED
    const meetsCreditsBar =
      credits !== null && credits <= PIPELINE_THRESHOLDS.HOT_CREDITS_REMAINING_MAX
    if (meetsAttendBar || meetsCreditsBar) return 'hot_conversion'
  }

  // ── Active Trial ─────────────────────────────────────────────
  // Trial status + still engaged OR within the new-joiner grace
  // window. Trial members who haven't engaged in 30+ days drop
  // through to lapsed/dormant below.
  if (status === 'trial') {
    const inGracePeriod = daysSinceJoined !== null && daysSinceJoined <= PIPELINE_THRESHOLDS.TRIAL_GRACE_DAYS
    if (recentlyAttended || inGracePeriod) return 'active_trial'
  }

  // ── Member states ────────────────────────────────────────────
  // member + credit_member can be: actively using, at risk, or
  // dropped through to lapsed/dormant. The at-risk window is
  // 30-90d since last booking — gives the operator a chance to
  // save the member proactively before they fully lapse.
  const isMemberStatus = status === 'member' || status === 'credit_member'
  if (isMemberStatus) {
    if (recentlyAttended || recentlyPaid) return 'active_member'
    if (daysSinceAttended !== null && daysSinceAttended <= PIPELINE_THRESHOLDS.AT_RISK_MAX_DAYS) {
      return 'at_risk_member'
    }
    if (lapsedWindow) return 'lapsed'
    // Member status but completely silent — old ghost record.
    return 'dormant'
  }

  // ── New Lead ─────────────────────────────────────────────────
  // Recently created/joined, hasn't attended yet, status hasn't
  // moved past the funnel-top buckets. Anything older than the
  // new-lead window drops to dormant — they've been sitting
  // unmoved for ages and aren't actionable.
  const newLeadStatuses = new Set(['lead', 'cold', 'tour', 'no_sale_tour', null])
  if (newLeadStatuses.has(status)) {
    const recentlyJoined = (
      (daysSinceJoined !== null && daysSinceJoined <= PIPELINE_THRESHOLDS.NEW_LEAD_RECENT_DAYS)
      || (daysSinceCreated !== null && daysSinceCreated <= PIPELINE_THRESHOLDS.NEW_LEAD_RECENT_DAYS)
    )
    if (recentlyJoined && !recentlyAttended) return 'new_lead'
  }

  // ── Lapsed ──────────────────────────────────────────────────
  // Catch-all for "was active in the lapsed window". Anyone who
  // booked between 60 and 180 days ago and didn't fit a more
  // specific bucket above lands here — winback candidates.
  if (lapsedWindow) return 'lapsed'

  // ── Dormant (terminal) ───────────────────────────────────────
  // Everything else. Old leads with no engagement, ex_members,
  // ghosts from years past. Hidden from the default Kanban view
  // via pipeline_stages.is_dormant=true. Operator can still
  // target them via audience filter.
  return 'dormant'
}
