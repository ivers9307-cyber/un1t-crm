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
//   gympass      — has a synced gympass_member_id (metadata.gympass) and
//                  isn't a paying member (off funnel — GYMPASS.2). Training
//                  via Gympass/Wellhub; can't be sold a membership, so out
//                  of the sellable funnel. A real membership outranks it.
//   cold_lead    — operator marked "not worth selling to / not interested"
//                  (FUNNEL.4, contacts.pipeline_dismissed_at). Off funnel,
//                  auto-revoked when they attend a class OR re-enter through a
//                  public funnel form (RETURNPIPE.3) after the dismissal.
//                  Members/pack/classpass outrank it.
//   dormant      — aged-out leads, ex_members, ghosts (off funnel)
//
// Attended counts come from contacts.recent_bookings (last 10 from the
// Glofox sync). For funnel-age leads that IS their complete history;
// last_attended_at backstops the count if the list was ever pruned.
//
// Pure function — same input, same output. Callers: applyMemberSync
// (per-webhook, near-instant) and the nightly pipeline-classify cron.
//
// SHARED-CORE (FUNNEL-M.1): this module lives in shared/ (moved from
// src/lib) because the mobile pipeline screen needs the funnel taxonomy
// and the stage-split helper, and shared/ is the only seam mobile can
// import across (repo invariant: mobile cannot import src/lib). It is
// 100% pure — no imports, no IO — so it runs identically under Metro
// and Node. Web callers keep importing '@/lib/pipeline-classifier',
// which re-exports everything from here (same pattern as race-control).

const DAY_MS = 24 * 60 * 60 * 1000

// ── Funnel taxonomy (FUNNEL.1) ─────────────────────────────────────
// The five on-funnel stages, in journey order. Everything else a
// classifyContact() call can return is an off-funnel pile. These lists
// mirror the pipeline_stages rows (is_dormant=false vs true) — the DB
// stage list is the source of truth for what *exists*; these constants
// are the source of truth for canonical ORDER when a caller needs it
// without a stage row in hand.
export const FUNNEL_STAGE_SLUGS = Object.freeze([
  'new_lead',
  'first_class',
  'second_class',
  'trial_done',
  'converted',
])

// RETURNPIPE.1 — the RETURNING board, in journey order. A separate pipeline
// because a returning customer follows a different flow from a new one
// (Richard, 2026-08-21): they are not being sold the idea of the gym, they are
// being re-sold a place they already know. Stage names are his.
//
// 'returning_booked' is the entry column: they have a class in the diary but
// have not turned up yet. Without it a booking is invisible until attendance,
// which is the defect FUNNEL.5 fixed on the acquisition board — and
// booked-but-never-showed would be an absence rather than a visible drop-off.
export const RETURNING_STAGE_SLUGS = Object.freeze([
  'returning_booked',
  'returning_first_class',
  'returning_second_class',
  'returning_final_class',
  'returning_converted',
])

// Off-funnel populations, display order. pack_member is a first-class
// group (FUNNEL.3): buying a Class Pack IS a conversion, reported in
// its own pile, never cycled back into the funnel.
export const OFF_FUNNEL_STAGE_SLUGS = Object.freeze([
  'member',
  'pack_member',
  'classpass',
  'gympass',
  'cold_lead',
  'dormant',
])

/**
 * Split pipeline_stages rows into the Funnel vs Off-funnel views —
 * the exact split src/app/pipeline/page.js renders as its two tabs:
 * archived rows dropped, then partitioned on is_dormant, ordered by
 * display_order (slug-taxonomy order as fallback for ties/missing).
 *
 * @param {Array<{id:string, slug?:string, is_dormant?:boolean, archived?:boolean, display_order?:number}>} stages
 * @returns {{ funnel: object[], offFunnel: object[] }}
 */
export function splitStagesByFunnel(stages) {
  const live = (Array.isArray(stages) ? stages : [])
    .filter((s) => s && s.archived !== true)

  const slugOrder = (s) => {
    const list = (s.board || 'acquisition') === 'returning'
      ? RETURNING_STAGE_SLUGS
      : (s.is_dormant ? OFF_FUNNEL_STAGE_SLUGS : FUNNEL_STAGE_SLUGS)
    const i = list.indexOf(s.slug)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const byOrder = (a, b) => {
    const ao = Number.isFinite(a.display_order) ? a.display_order : null
    const bo = Number.isFinite(b.display_order) ? b.display_order : null
    if (ao !== null && bo !== null && ao !== bo) return ao - bo
    if (ao !== null && bo === null) return -1
    if (ao === null && bo !== null) return 1
    return slugOrder(a) - slugOrder(b)
  }

  // RETURNPIPE.1 — `board` is the third axis. A stage with no board (every row
  // predating mig 558, and anything a caller hands us without the column)
  // reads as 'acquisition', so the two original groups are byte-identical to
  // what they were and no existing caller changes behaviour.
  const boardOf = (s) => s.board || 'acquisition'
  const acquisition = live.filter((s) => boardOf(s) === 'acquisition')

  return {
    funnel: acquisition.filter((s) => !s.is_dormant).sort(byOrder),
    offFunnel: acquisition.filter((s) => Boolean(s.is_dormant)).sort(byOrder),
    returning: live.filter((s) => boardOf(s) === 'returning').sort(byOrder),
  }
}

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
  // RETURNPIPE.1 — a break of this many days between attendances means they
  // LEFT and came back, rather than simply trained irregularly. Matched to
  // FUNNEL_ACTIVITY_DAYS on purpose: 60 days is already this system's
  // definition of "no longer active", so a return is re-entry after the
  // acquisition funnel had given up on them.
  RETURN_GAP_DAYS: 60,
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

/**
 * RETURNPIPE.1 — how far into THIS return the contact is, or null when they
 * are not on a return journey at all.
 *
 * A "return" is re-entry after the acquisition funnel had already given up:
 * the first attendance following a gap of >= RETURN_GAP_DAYS, or — for
 * someone who has trained before and has a class in the diary but has not
 * turned up yet — the booking itself.
 *
 * Counting is scoped to the episode, never lifetime. Someone who trained nine
 * times two years ago and has just come back once is on their FIRST class
 * back; reading their old total would drop them straight into "Final class"
 * and tell a coach the opposite of what is true.
 *
 * Derived entirely from data already on the contact — no episode table, no
 * per-contact stamp to backfill or keep in sync — so it works retroactively
 * on everyone already in the database.
 *
 * @returns {{attended: number, hasUpcoming: boolean}|null}
 */
export function returnEpisode(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return null

  const gapMs = PIPELINE_THRESHOLDS.RETURN_GAP_DAYS * DAY_MS
  const hasUpcoming = nextBookedClass(contact.recent_bookings, now) !== null

  // Attendances we can see, oldest first. recent_bookings holds the last 10
  // from the Glofox sync, so this is a window and not a full history — a gap
  // inside the window is evidence of a return; the absence of one is not
  // evidence there was never a break.
  const attendedTimes = (Array.isArray(contact.recent_bookings) ? contact.recent_bookings : [])
    .filter((b) => b && b.attended === true && Number.isFinite(Number(b.time_start)))
    .map((b) => Number(b.time_start) * 1000)
    .filter((ms) => ms <= now)
    .sort((a, b) => a - b)

  // Find the LAST gap in the window; everything after it is this episode.
  let episodeStart = null
  for (let i = 1; i < attendedTimes.length; i++) {
    if (attendedTimes[i] - attendedTimes[i - 1] >= gapMs) episodeStart = attendedTimes[i]
  }

  if (episodeStart !== null) {
    return { attended: attendedTimes.filter((t) => t >= episodeStart).length, hasUpcoming }
  }

  // No gap visible in the window. The other shape of a return: they trained
  // long enough ago to have fallen out of the funnel, and have now booked.
  // last_attended_at is advance-only and persists after recent_bookings has
  // rolled past, so it is the reliable long-memory signal here.
  const sinceAttended = daysSince(contact.last_attended_at, now)
  const lapsed = sinceAttended !== null && sinceAttended >= PIPELINE_THRESHOLDS.RETURN_GAP_DAYS
  if (lapsed && hasUpcoming) return { attended: 0, hasUpcoming: true }

  return null
}

/** RETURNPIPE.1 — episode progress → the returning board's stage. */
function returningStage(episode) {
  if (!episode) return null
  if (episode.attended <= 0) return episode.hasUpcoming ? 'returning_booked' : null
  if (episode.attended === 1) return 'returning_first_class'
  if (episode.attended === 2) return 'returning_second_class'
  return 'returning_final_class'
}

export function classifyContact(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return 'dormant'
  const status = contact.glofox_membership_status || null

  // ── Members: recently converted → the funnel's win column ──────
  if (status === 'member' || status === 'credit_member') {
    const sinceConverted = daysSince(contact.converted_at, now)
    if (sinceConverted !== null && sinceConverted <= PIPELINE_THRESHOLDS.CONVERTED_WINDOW_DAYS) {
      // RETURNPIPE.1 — a win belongs to the board that earned it. Someone who
      // came back and re-joined is the returning pipeline's Converted column,
      // not the acquisition funnel's. Bounded to the same CONVERTED_WINDOW as
      // before, so a member outside it still falls through to 'member' exactly
      // as today — this can only ever move someone already in Converted.
      return returnEpisode(contact, now) ? 'returning_converted' : 'converted'
    }
    return 'member'
  }

  // ── Gympass: training via the Gympass/Wellhub platform ─────────
  // GYMPASS.2 (Richard, 2026-07-20): a Gympass user can't be sold a
  // membership, so they're pulled OUT of the sellable funnel into their
  // own off-funnel pile — keyed off the synced gympass_member_id
  // (metadata.gympass.id, GYMPASS.1). Checked AFTER member/converted so a
  // Gympass user who buys a real membership graduates to the member
  // category (the Glofox profile is shared); checked BEFORE the funnel
  // rules so an attending Gympass lead never shows as a hot trial prospect.
  if (contact.gympass_member_id) return 'gympass'

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

  // ── Cold — operator-dismissed (FUNNEL.4) ───────────────────────
  // A staffer marked this lead "not worth selling to / not interested"
  // with the Cold button (contacts.pipeline_dismissed_at). Removes them
  // from the funnel — but AUTO-REVOKED the moment they come back and
  // TRAIN: if last_attended_at is after the dismissal, the dismissal is
  // stale and they fall through to the normal funnel rules below and
  // rejoin (Richard, 2026-07-04). Paying-customer states (member / pack /
  // classpass) are checked above, so a cold lead who later converts or
  // buys a pack still shows correctly.
  const dismissedMs = contact.pipeline_dismissed_at
    ? new Date(contact.pipeline_dismissed_at).getTime()
    : null
  if (dismissedMs !== null && Number.isFinite(dismissedMs)) {
    const attendedMs = contact.last_attended_at
      ? new Date(contact.last_attended_at).getTime()
      : null
    const trainedSinceDismissal = attendedMs !== null
      && Number.isFinite(attendedMs) && attendedMs > dismissedMs

    // RETURNPIPE.3 — coming back through a public funnel form also revokes it
    // (Richard, 2026-08-21): "a cold lead that comes in on the /start form
    // gets reclassified as a lead". Being dismissed is a judgement about
    // someone who went quiet; filling the form in again is that person
    // answering. Attending was the only way back before, which meant we told
    // them nothing had changed right up until they physically arrived.
    //
    // last_lead_source_at (mig 557) is stamped on EVERY public funnel entry —
    // /start's class booking and the website lead form both — so it is the
    // precise signal for "came in on the form", and it does not wait on a
    // Glofox booking sync. It persists, so the revocation is permanent: they
    // only go cold again if a human dismisses them a second time, which
    // stamps a newer pipeline_dismissed_at.
    const reEnteredMs = contact.last_lead_source_at
      ? new Date(contact.last_lead_source_at).getTime() : null
    const reEnteredSinceDismissal = reEnteredMs !== null
      && Number.isFinite(reEnteredMs) && reEnteredMs > dismissedMs

    if (!trainedSinceDismissal && !reEnteredSinceDismissal) return 'cold_lead'
    // Falling through routes them by history, which is exactly the split
    // asked for: never trained -> new_lead on the acquisition board; trained
    // before -> the returning board via returnEpisode below.
  }

  // ── RETURNING BOARD (RETURNPIPE.1) ─────────────────────────────
  // Checked here, at the top of the funnel-candidate section, so it can only
  // ever reroute someone who would otherwise land in the acquisition funnel or
  // in dormant. Every pile above — member, gympass, classpass, ex_member,
  // pack_member, cold_lead — is untouched, which is the whole 3,000+ contact
  // majority of the board.
  //
  // cold_lead deliberately still wins: a dismissal is an explicit human
  // judgement, and the existing rule only lets ATTENDING overturn it. 92 of
  // the 112 dismissed contacts are in the live trial sequence, so if that
  // decision should change it is a product call, not something to slip in
  // behind a layout change.
  const episode = returnEpisode(contact, now)
  if (episode) {
    const stage = returningStage(episode)
    if (stage) return stage
  }

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

  // FUNNEL.5 — A BOOKED CLASS IN THE DIARY IS NOT DORMANT.
  //
  // 'dormant' means "aged-out leads, ex_members, ghosts" (see the taxonomy
  // above). Someone who has just booked a class for next week is none of
  // those, but until now that is exactly where they landed: every rule below
  // keys on ATTENDANCE, and booking does not move last_attended_at. So a
  // re-engaging contact stayed filed as a ghost until they physically turned
  // up — and if they never did, the pipeline never showed they had tried.
  //
  // Measured 2026-08-20, the evening the 3-Class Trial sequence went out: 12
  // people booked through /start, 10 of them sat in `dormant`, and 8 had an
  // upcoming BOOKED class at the moment they were classified. The board was
  // asserting something demonstrably false about live customers.
  //
  // This is the same shape as the cold_lead rule directly above, which is
  // auto-revoked when someone trains after being dismissed: an action by the
  // contact overrides an off-funnel pile they were sorted into by decay.
  //
  // Deliberately UPCOMING only (nextBookedClass ignores anything in the past).
  // A booking they already missed is not re-engagement, and if they attended
  // it, last_attended_at moved and the attendance rules below handle them
  // properly anyway.
  const hasUpcomingClass = nextBookedClass(contact.recent_bookings, now) !== null

  if (attended >= 1) {
    const stillActive = sinceAttended !== null
      && sinceAttended <= PIPELINE_THRESHOLDS.FUNNEL_ACTIVITY_DAYS
    // Back in the diary after aging out: top of the funnel, not a ghost. They
    // have no COMPLETED class in this cycle, so new_lead rather than
    // first_class — the count below describes a previous visit, not this one.
    if (!stillActive) return hasUpcomingClass ? 'new_lead' : 'dormant'
    if (attended >= PIPELINE_THRESHOLDS.TRIAL_DONE_MIN_ATTENDED) return 'trial_done'
    return attended === 2 ? 'second_class' : 'first_class'
  }

  const recentlyJoined = sinceJoined !== null
    && sinceJoined <= PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS
  return (recentlyJoined || hasUpcomingClass) ? 'new_lead' : 'dormant'
}
