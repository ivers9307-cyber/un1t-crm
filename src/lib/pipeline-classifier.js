// FUNNEL.1 — acquisition-funnel classifier (operator-approved 2026-07-02).
//
// The pipeline is now a pure lead→member funnel. Member lifecycle
// (at-risk / lapsed) is the Churn Radar's job — it keys on Glofox
// status and never read pipeline slugs, so nothing breaks.
//
// Stage definitions:
//   new_lead     — non-member, 0 classes attended, joined ≤60d ago
//                  (joined_at ONLY — lead_created_at is import-poisoned)
//   first_class  — 1 class attended, last attended ≤60d
//   second_class — 2 classes attended, last attended ≤60d
//   trial_done   — 3+ attended, not yet a member. THE decision point.
//   converted    — became member/credit_member ≤60d ago (converted_at,
//                  stamped by applyMemberSync on the status transition)
//   member       — converted >60d ago, or pre-existing member (off funnel)
//   pack_member  — Class Pack customer (FUNNEL.3): stamped
//                  pack_customer_at, or live 4+ active credits. A pack
//                  purchase IS a conversion — reported here, never back
//                  in the funnel. Membership outranks it. (off funnel)
//   classpass    — classpass_payg, always (off funnel — distinct motion;
//                  the ClassPass PLATFORM, not our Class Packs)
//   dormant      — aged-out leads, ex_members, ghosts (off funnel)
//
// Attended counts come from contacts.recent_bookings (last 10 from the
// Glofox sync). For funnel-age leads that IS their complete history;
// last_attended_at backstops the count if the list was ever pruned.
//
// Pure function — same input, same output. Callers: applyMemberSync
// (per-webhook, near-instant) and the nightly pipeline-classify cron.

const DAY_MS = 24 * 60 * 60 * 1000

export const PIPELINE_THRESHOLDS = {
  // Column 1 entry window, keyed on joined_at (Glofox tenure date).
  NEW_LEAD_WINDOW_DAYS:    60,
  // Columns 2–4 stay on the board while the lead is still active —
  // keyed on last attendance so a mid-trial lead doesn't vanish when
  // their joined_at crosses 60d.
  FUNNEL_ACTIVITY_DAYS:    60,
  // Column 5 window, keyed on converted_at; then off-board to member.
  CONVERTED_WINDOW_DAYS:   60,
  // 3 classes ≈ a completed trial pack → decision point.
  TRIAL_DONE_MIN_ATTENDED: 3,
  // 4+ active credits can't come from a trial (ours are ≤3) — the
  // contact bought a class pack. Buying a pack IS a conversion: they
  // classify to the off-funnel pack_member stage (sticky via
  // contacts.pack_customer_at) and never re-enter the funnel. FUNNEL.3.
  PACK_CUSTOMER_MIN_CREDITS: 4,
}

// Helper: days elapsed between an ISO timestamp and `now` (epoch ms).
// Returns null when the timestamp is missing/unparseable. A FUTURE
// timestamp clamps to 0 ("0 days ago") — check-in can flag attendance
// before class start, and that freshly-flagged attendance must count
// as active, not fall out of every recency window.
function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  if (ms < 0) return 0
  return ms / DAY_MS
}

/** Count attended classes in a recent_bookings jsonb array. */
export function countAttendedBookings(recentBookings) {
  if (!Array.isArray(recentBookings)) return 0
  return recentBookings.filter((b) => b && b.attended === true).length
}

/**
 * Soonest FUTURE booked class in a recent_bookings array, as an ISO
 * string, or null. Drives the board's "next class booked" badge.
 * time_start is unix SECONDS (Glofox payload convention).
 */
export function nextBookedClass(recentBookings, now = Date.now()) {
  if (!Array.isArray(recentBookings)) return null
  let soonest = null
  for (const b of recentBookings) {
    if (!b || String(b.status || '').toUpperCase() !== 'BOOKED') continue
    const ms = Number(b.time_start) * 1000
    if (!Number.isFinite(ms) || ms <= now) continue
    if (soonest === null || ms < soonest) soonest = ms
  }
  return soonest === null ? null : new Date(soonest).toISOString()
}

export function classifyContact(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return 'dormant'
  const status = contact.glofox_membership_status || null

  // ── Members: recently converted → the funnel's win column ──────
  if (status === 'member' || status === 'credit_member') {
    const sinceConverted = daysSince(contact.converted_at, now)
    if (sinceConverted !== null && sinceConverted <= PIPELINE_THRESHOLDS.CONVERTED_WINDOW_DAYS) {
      return 'converted'
    }
    return 'member'
  }

  // ── ClassPass: excluded from the funnel entirely ───────────────
  if (status === 'classpass_payg') return 'classpass'

  // ── Ex-members are winback targets, not funnel leads ───────────
  if (status === 'ex_member') return 'dormant'

  // ── Pack customers (FUNNEL.3) ──────────────────────────────────
  // Operator decision (Richard, 2026-07-03): the funnel exists to get
  // NEW leads across the line to a membership OR a class pack — buying
  // a pack IS the conversion. Pack customers are reported in their own
  // off-funnel stage and must NEVER cycle back into the funnel when
  // credits run low ("clogging it with these users is not what we
  // need"). Two signals, either qualifies:
  //   - pack_customer_at (mig 356): the durable write-once stamp, set
  //     by applyMemberSync the first time a non-member is observed
  //     holding 4+ active credits. Sticky — survives the pack running
  //     out. Membership status outranks it (checked above).
  //   - live credits ≥4: covers the sync tick before the stamp lands.
  // The ≥4 floor exists because UN1T trials are ≤3 credits and the
  // mig-001 schema default of 3 must stay harmless. Glofox lead-status
  // hygiene can't be relied on (Wendy Bertrand: 'cold' with a 16-credit
  // active pack; Sarah Cousins: 'cold' with 206 credits).
  const credits = Number.isFinite(contact.trial_credits_remaining)
    ? contact.trial_credits_remaining
    : null
  const isPackCustomer = Boolean(contact.pack_customer_at)
    || (credits !== null && credits >= PIPELINE_THRESHOLDS.PACK_CUSTOMER_MIN_CREDITS)
  if (isPackCustomer) return 'pack_member'

  // ── Funnel candidates: lead/cold/tour/no_sale_*/trial/null ─────
  // last_attended_at backstops the count: it's advance-only on the
  // persisted row, so a non-empty value means ≥1 attendance even if
  // recent_bookings was pruned.
  const attended = Math.max(
    countAttendedBookings(contact.recent_bookings),
    contact.last_attended_at ? 1 : 0,
  )
  const sinceAttended = daysSince(contact.last_attended_at, now)
  const sinceJoined   = daysSince(contact.joined_at, now)

  if (attended >= 1) {
    const stillActive = sinceAttended !== null
      && sinceAttended <= PIPELINE_THRESHOLDS.FUNNEL_ACTIVITY_DAYS
    if (!stillActive) return 'dormant'
    if (attended >= PIPELINE_THRESHOLDS.TRIAL_DONE_MIN_ATTENDED) return 'trial_done'
    return attended === 2 ? 'second_class' : 'first_class'
  }

  const recentlyJoined = sinceJoined !== null
    && sinceJoined <= PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS
  return recentlyJoined ? 'new_lead' : 'dormant'
}
