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
// pure — no IO, and its one import is the equally pure sibling board module
// shared/pipelines/returning.js — so it runs identically under Metro and
// Node. Web callers keep importing '@/lib/pipeline-classifier', which
// re-exports everything from here (same pattern as race-control).

import { RETURNING_STAGE_SLUGS, returnEpisode } from './pipelines/returning.js'

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

// PIPELINES.2b — RETURNING_STAGE_SLUGS and returnEpisode now LIVE in
// shared/pipelines/returning.js (with the RETURNPIPE.1 war story that explains
// them), and are re-exported from here so every existing import keeps working
// unchanged: src/lib/pipeline-classifier.js re-exports both, and
// src/components/mail/ConversationThread.jsx reads RETURNING_STAGE_SLUGS off
// '@/lib/pipeline-classifier' to build its stage picker.
//
// The taxonomy is still true and mig 558's stage rows are still in prod. What
// changed is that classifyContact() no longer ROUTES anyone to them — see the
// two PIPELINES.2b notes further down, and returning.js for the operator
// decision and the coverage numbers behind it.
export { RETURNING_STAGE_SLUGS, returnEpisode }

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
 * Split ONE BOARD's pipeline_stages rows into the Funnel vs Off-funnel views —
 * the exact split src/app/(sales)/pipeline/page.js renders as its two tabs:
 * archived rows dropped, then partitioned on is_dormant, ordered by
 * display_order (slug-taxonomy order as fallback for ties/missing).
 *
 * PIPELINES.6 — `board` is no longer an axis here. RETURNPIPE.1 (mig 558) had
 * added a text `pipeline_stages.board` column and made this function partition
 * on it as well, because a location's stage rows were one undifferentiated
 * list and something had to keep two boards apart. PIPELINES.1 (mig 594) gave
 * a board an identity of its own — a `pipelines` row with a key, a module and
 * a mode — and `pipeline_stages.pipeline_id` now points at it, so the CALLER
 * scopes its query to one board (`.eq('pipeline_id', …)`) and hands us that
 * board's stages. The `board` column stays on disk, unread, until a later
 * migration drops it (deprecated-columns-stay-on-disk convention).
 *
 * So `is_dormant` means exactly what it meant BEFORE mig 558 introduced the
 * third axis: "parked, not moving through THIS board" — not "parked at this
 * location". A row carrying a legacy `board` value is inert data.
 *
 * A manual board (pipelines.mode='manual') has nothing off-funnel — a human
 * decides where each card sits — so its rows all carry is_dormant=false and
 * come back in `funnel`, in display_order. Nothing special is needed here for
 * that; the caller simply renders one view.
 *
 * @param {Array<{id:string, slug?:string, is_dormant?:boolean, archived?:boolean, display_order?:number}>} stages
 * @returns {{ funnel: object[], offFunnel: object[] }}
 */
export function splitStagesByFunnel(stages) {
  const live = (Array.isArray(stages) ? stages : [])
    .filter((s) => s && s.archived !== true)

  // Fallback ordering only — display_order wins whenever both rows have one.
  // A board with slugs outside the acquisition taxonomy (any manual board)
  // scores MAX_SAFE_INTEGER on every row, so ties fall back to input order.
  const slugOrder = (s) => {
    const list = s.is_dormant ? OFF_FUNNEL_STAGE_SLUGS : FUNNEL_STAGE_SLUGS
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

  return {
    funnel: live.filter((s) => !s.is_dormant).sort(byOrder),
    offFunnel: live.filter((s) => Boolean(s.is_dormant)).sort(byOrder),
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

// RETURNPIPE.1's returnEpisode() and returningStage() used to sit here, between
// nextBookedClass() and classifyContact(). PIPELINES.2b moved them, whole and
// comment-for-comment, to shared/pipelines/returning.js — the board module for
// the pipeline they serve — because classifyContact() no longer calls either
// one. returnEpisode is re-exported at the top of this file, so callers that
// ask "is this person on a comeback?" are unaffected; it simply no longer
// decides where the deal sits.

export function classifyContact(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return 'dormant'
  const status = contact.glofox_membership_status || null

  // ── Members: recently converted → the funnel's win column ──────
  if (status === 'member' || status === 'credit_member') {
    const sinceConverted = daysSince(contact.converted_at, now)
    if (sinceConverted !== null && sinceConverted <= PIPELINE_THRESHOLDS.CONVERTED_WINDOW_DAYS) {
      // PIPELINES.2b — the returning board is PARKED, so every win in this
      // window is the acquisition funnel's. This line used to read
      // `returnEpisode(contact, now) ? 'returning_converted' : 'converted'`, on
      // the RETURNPIPE.1 principle that a win belongs to the board that earned
      // it: a member who went quiet, came back and re-joined was the returning
      // pipeline's Converted column, not this one's.
      //
      // The principle is not wrong. The board is not running. Richard,
      // 2026-09-08: "no to returning for now" — measured against prod it holds
      // 0 deals and cannot fill (only 6.8% of Stillorgan contacts have
      // last_attended_at at all, and the count lapsed-with-a-future-booking is
      // zero). Handing the orchestrator a slug whose board declares no column
      // leaves the deal nowhere to go, so classifyContact() must not route to
      // a board that is not running. Provably a no-op: deals sitting on
      // returning_* stages = 0, across every deal status.
      //
      // classifyContact() is now the ACQUISITION board's rule set and nothing
      // else. The returning journey survives intact — rules, thresholds and
      // war stories — in shared/pipelines/returning.js, deliberately
      // unregistered in shared/pipelines/index.js.
      return 'converted'
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
    // Falling through routes them by history. RETURNPIPE.3 asked for a split
    // — never trained -> new_lead on the acquisition board; trained before ->
    // the returning board — and with that board parked (PIPELINES.2b) both
    // halves now land here: a lapsed re-booker reaches 'new_lead' via FUNNEL.5
    // below, and someone who has trained recently is placed by the attendance
    // rules. The split itself is what re-enabling the board would restore.
  }

  // ── The RETURNING BOARD was checked HERE (RETURNPIPE.1) ────────
  // PIPELINES.2b took it out. It sat at the top of the funnel-candidate
  // section precisely so it could only ever claim someone who would otherwise
  // land in the acquisition funnel or in dormant — which is also why removing
  // it is contained: every pile above (member, gympass, classpass, ex_member,
  // pack_member, cold_lead) never passed through it, and those piles are the
  // 3,000+ contact majority of the board.
  //
  // The board is PARKED, not deleted. Richard, 2026-09-08: "no to returning
  // for now". Measured against prod the same day, it holds 0 deals and cannot
  // fill, because the signal simply is not there: 581 of 8,594 Stillorgan
  // contacts (6.8%) have last_attended_at at all, 602 have any recent_bookings,
  // contacts lapsed 90-540 days number 15, and the entry column needs
  // lapsed-PLUS-a-future-booking — which nobody satisfies. Meanwhile a
  // classifier that routes to a board that is not running returns one of five
  // slugs the acquisition board declares no column for, and the orchestrator
  // has nowhere to put that deal. Provably a no-op to remove: deals sitting on
  // returning_* stages = 0, across every deal status.
  //
  // So classifyContact() is the acquisition board's rule set, and only that.
  // The rules this block ran — returnEpisode(), returningStage(), and the
  // episode-scoping story that is the hard-won part (nine classes two years
  // ago plus one today is a FIRST class back, not a finished trial) — live in
  // shared/pipelines/returning.js, kept whole and deliberately unregistered,
  // ready to switch on if attendance coverage ever improves.
  //
  // What the contacts this used to claim get instead is the rules below, and
  // FUNNEL.5 catches the shape that matters: someone lapsed with a class in
  // the diary is 'new_lead', not 'dormant'. What is lost is the DISTINCTION
  // between a first-timer and a comeback, and the episode-scoped count — which
  // is exactly what re-enabling the board would give back.

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
