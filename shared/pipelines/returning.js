// PIPELINES.2b — the RETURNING board, as a board module. DELIBERATELY NOT
// REGISTERED in shared/pipelines/index.js.
//
// ─── Why it is parked ────────────────────────────────────────────────────────
//
// Richard, 2026-09-08: "no to returning for now". The measurement behind that
// call, taken against production the same day: the board holds **0 deals** and
// cannot fill.
//
//   • only 581 of 8,594 Stillorgan contacts (6.8%) have last_attended_at at all
//   • only 602 have any recent_bookings
//   • contacts lapsed 90–540 days: 15
//   • its entry column needs lapsed-PLUS-a-future-booking: nobody qualifies
//
// So the returning journey is real, but the signal that would populate it is
// not there. classifyContact() used to reroute into it, which meant the
// acquisition board's classifier could return one of five slugs the
// acquisition board does not declare — a stage the orchestrator has no column
// to put the deal in. PIPELINES.2b removed those two reroutes; the logic they
// used moved here rather than being deleted.
//
// ─── Why it is kept intact ───────────────────────────────────────────────────
//
// The rules are operator-approved and the war stories behind them (RETURNPIPE.1
// / RETURNPIPE.3, below, verbatim) took real measurement to get right. If
// attendance coverage ever improves — a Glofox history backfill, or simply
// enough time with the current sync — switching the board on is one line in
// index.js plus a pipelines row, not a rewrite. Deleting it would mean
// re-deriving the episode-scoping rule from scratch, and that is the part that
// is easy to get wrong (see the "counts THIS return only" note on
// returnEpisode).
//
// Turning it on is a PRODUCT decision, not a cleanup: it needs Richard, a
// pipelines row with module='returning', the mig-558 stage rows, and a
// re-measurement of the coverage numbers above. Do not register it because the
// module happens to be here.

import { nextBookedClass, PIPELINE_THRESHOLDS } from '../pipeline-classifier.js'

// Local copies of the classifier's two private helpers. They are private there
// (no export) and this module must not widen that surface just to borrow them;
// both are three lines of pure arithmetic. Keep them in step if the originals
// ever change — shared/pipeline-classifier.js is the source of truth.
const DAY_MS = 24 * 60 * 60 * 1000

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

// Mirrors the live prod rows (mig 558). Order 401+ sorts after the
// acquisition board's 300-block. Every row is on-funnel (is_dormant=false):
// the returning board has no off-funnel piles — someone who stops returning
// falls back to the acquisition board's rules, which own 'dormant'.
export const stages = Object.freeze([
  { slug: 'returning_booked',       name: 'Booked back in', display_order: 401, color: '#378ADD', is_dormant: false },
  { slug: 'returning_first_class',  name: '1st class back', display_order: 402, color: '#1D9E75', is_dormant: false },
  { slug: 'returning_second_class', name: '2nd class back', display_order: 403, color: '#5DCAA5', is_dormant: false },
  { slug: 'returning_final_class',  name: 'Final class',    display_order: 404, color: '#EF9F27', is_dormant: false },
  { slug: 'returning_converted',    name: 'Converted',      display_order: 405, color: '#0F6E56', is_dormant: false },
])

// Every contacts column classify() reads, directly or through returnEpisode().
// Same contract as acquisition.js: the orchestrator unions what each board
// DECLARES, so a field omitted here is a field classified on null.
export const requiredFields = Object.freeze([
  'id',
  'name',
  'email',
  'glofox_membership_status',
  'last_attended_at',
  'recent_bookings',
  'converted_at',
])

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
 * Still exported and still correct with the board parked: it is what the
 * ContactDrawer and any future re-enable would read. It just no longer decides
 * placement.
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
export function returningStage(episode) {
  if (!episode) return null
  if (episode.attended <= 0) return episode.hasUpcoming ? 'returning_booked' : null
  if (episode.attended === 1) return 'returning_first_class'
  if (episode.attended === 2) return 'returning_second_class'
  return 'returning_final_class'
}

// This board ABSTAINS — unlike acquisition, which always answers. A contact
// who is not on a return episode is not this board's business, and null is the
// contract's "close the deal" signal (see the note on acquisition.classify).
//
// The two branches below are exactly the two reroutes PIPELINES.2b removed
// from classifyContact(), reassembled in the order the classifier applied
// them:
//
//   • the member branch (classifier ~line 276): a win belongs to the board
//     that earned it. Someone who came back and re-joined is the returning
//     pipeline's Converted column, not the acquisition funnel's. Bounded to
//     the same CONVERTED_WINDOW, so a member outside it is not this board's.
//   • the funnel-candidate branch (classifier ~line 375): checked at the top
//     of the funnel-candidate section, so it could only ever claim someone who
//     would otherwise land in the acquisition funnel or in dormant. Every pile
//     above it — member, gympass, classpass, ex_member, pack_member, cold_lead
//     — was untouched, and stays that way here: this module never sees them,
//     because the orchestrator asks the acquisition board too and those piles
//     are its answer.
//
// cold_lead deliberately still wins on the acquisition side: a dismissal is an
// explicit human judgement, and the existing rule only lets ATTENDING overturn
// it. That ordering lives in classifyContact() and is not re-litigated here.
export function classify(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return null

  const episode = returnEpisode(contact, now)
  if (!episode) return null

  const status = contact.glofox_membership_status || null
  if (status === 'member' || status === 'credit_member') {
    const sinceConverted = daysSince(contact.converted_at, now)
    return (sinceConverted !== null && sinceConverted <= PIPELINE_THRESHOLDS.CONVERTED_WINDOW_DAYS)
      ? 'returning_converted'
      : null
  }

  return returningStage(episode)
}
