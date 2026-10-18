// HATCHPIPE.5 — the real dates behind a un1t.online board's cards.
//
// Hatch Street's acquisition board was created whole by its first
// classification run (18 Oct 2026), so every card read "Entered <stage> today"
// and "today total". The un1t.online mirror knows better: when the client was
// created, when each class they attended started, when they first paid. These
// rules turn that evidence (shapePipelineDateEvidence in un1t-online-shape.js)
// into the two dates a deal carries:
//
//   created_at        the card's "total": when the person entered the funnel
//   stage_entered_at  when they entered the stage the deal sits in
//
// Each rule dates the evidence classifyContact() (shared/pipeline-classifier.js)
// used to put them there, and nothing else. Where the evidence cannot say,
// the answer is null and the caller keeps today's behaviour (now). Pure; reads
// no clock except the `now` it is given.

import { PIPELINE_THRESHOLDS } from '@shared/pipeline-classifier'

const DAY_MS = 86_400_000

const msOf = (v) => {
  if (v == null || v === '') return null
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}

// A readable instant no later than now, as an ISO string; else null.
const past = (ms, now) => (ms != null && ms <= now ? new Date(ms).toISOString() : null)

const earliestMs = (values) => values.map(msOf).filter((m) => m != null)
  .reduce((best, m) => (best == null || m < best ? m : best), null)

// Attended booking starts, oldest first, by START TIME (never input order).
const attendedMs = (e) => (Array.isArray(e?.attended_starts) ? e.attended_starts : [])
  .map(msOf).filter((m) => m != null).sort((a, b) => a - b)

const hasAttended = (e) => attendedMs(e).length > 0 || msOf(e?.last_attended_at) != null

/**
 * When the deal entered `stageSlug`, from the person's un1t.online evidence.
 *
 *   new_lead      joined_at (the later of the client's creation and the newest
 *                 trial: the field classify keys the window on), else the
 *                 client's creation. Null when they have
 *                 attended (a lapsed re-booker re-enters new_lead through a
 *                 booked class, which creation does not date) or joined
 *                 outside NEW_LEAD_WINDOW_DAYS (same reason).
 *   first_class   start of the FIRST attended booking; with none listed,
 *                 last_attended_at (classify counts that as one class).
 *   second_class  start of the SECOND attended booking.
 *   trial_done    start of the attended booking that made the count reach
 *                 TRIAL_DONE_MIN_ATTENDED (3): classify's own trial_done rule
 *                 is "attended >= TRIAL_DONE_MIN_ATTENDED", so the trial was
 *                 done when that class happened, not at the latest one.
 *   converted     converted_at: the first sub_initial sale, which is the
 *                 field classify reads for the converted window.
 *   member        converted_at + CONVERTED_WINDOW_DAYS: when classify moves a
 *                 member from 'converted' to 'member'. With no converted_at,
 *                 the qualifying subscription's start (member_since), or for a
 *                 credit_member (paid credits) the paid pack (pack_customer_at).
 *   pack_member   pack_customer_at: the first paid pack transaction.
 *   classpass     the first non-Gympass aggregator booking (classpass_since).
 *   gympass       the first Wellhub / Gympass booking (gympass_since).
 *   cold_lead     the dismissal (dismissed_at).
 *   dormant       ex_member: the membership's end; attended: last attendance
 *                 + FUNNEL_ACTIVITY_DAYS; never attended: joined_at +
 *                 NEW_LEAD_WINDOW_DAYS (the moment classify's window closed).
 *
 * A date after `now` is null (never a future date). Attended bookings are
 * ordered by start time; an unreadable time is ignored.
 *
 * Caveat, shared with classify: the snapshot's recent_bookings is the newest
 * 10 bookings, so for someone with more than 10 bookings classify counts a
 * window while these rules count every attended booking. At Hatch (data from
 * 19 Aug 2026) that is a handful of people, and the earlier, fuller count is
 * the truer "when".
 *
 * @param {string} stageSlug
 * @param {object|null} evidence  see shapePipelineDateEvidence
 * @param {number} [now]          epoch ms
 * @returns {string|null} ISO timestamp
 */
export function un1tStageEnteredAt(stageSlug, evidence, now = Date.now()) {
  if (!evidence || typeof evidence !== 'object') return null
  const e = evidence
  const attended = attendedMs(e)
  const nth = (n) => (attended.length >= n ? attended[n - 1] : null)

  switch (stageSlug) {
    case 'new_lead': {
      if (hasAttended(e)) return null
      const joined = msOf(e.joined_at) ?? msOf(e.client_created_at)
      if (joined != null && now - joined > PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS * DAY_MS) return null
      return past(msOf(e.joined_at) ?? msOf(e.client_created_at), now)
    }
    case 'first_class':
      return past(attended.length ? attended[0] : msOf(e.last_attended_at), now)
    case 'second_class':
      return past(nth(2), now)
    case 'trial_done':
      return past(nth(PIPELINE_THRESHOLDS.TRIAL_DONE_MIN_ATTENDED), now)
    case 'converted':
      return past(msOf(e.converted_at), now)
    case 'member': {
      // classify keeps a member in 'converted' for CONVERTED_WINDOW_DAYS after
      // converted_at, then moves them to 'member': that crossing is the date.
      const converted = msOf(e.converted_at)
      if (converted != null) return past(converted + PIPELINE_THRESHOLDS.CONVERTED_WINDOW_DAYS * DAY_MS, now)
      // No first sale on file: classify placed them in 'member' outright.
      return past(msOf(e.membership_status === 'credit_member' ? e.pack_customer_at : e.member_since), now)
    }
    case 'pack_member':
      return past(msOf(e.pack_customer_at), now)
    case 'classpass':
      return past(msOf(e.classpass_since), now)
    case 'gympass':
      return past(msOf(e.gympass_since), now)
    case 'cold_lead':
      return past(msOf(e.dismissed_at), now)
    case 'dormant': {
      if (e.membership_status === 'ex_member') return past(msOf(e.membership_ended_at), now)
      if (hasAttended(e)) {
        const last = Math.max(...[...attended, msOf(e.last_attended_at)].filter((m) => m != null))
        return past(last + PIPELINE_THRESHOLDS.FUNNEL_ACTIVITY_DAYS * DAY_MS, now)
      }
      const joined = msOf(e.joined_at)
      return past(joined == null ? null : joined + PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS * DAY_MS, now)
    }
    default:
      return null
  }
}

/**
 * When the person entered the funnel (the card's "total", deal created_at):
 * the un1t.online client's creation. Null when unknown or after `now`.
 */
export function un1tFunnelEnteredAt(evidence, now = Date.now()) {
  if (!evidence || typeof evidence !== 'object') return null
  return past(msOf(evidence.client_created_at), now)
}

/**
 * Both dates for a deal in `stageSlug`. created_at is the funnel date, pulled
 * back to the stage date when that is earlier (a booking synced before its
 * client row), so the total is never shorter than the time in stage. When
 * there is no funnel date, the stage date stands in for it. Either may be null.
 *
 * @returns {{ created_at: string|null, stage_entered_at: string|null }}
 */
export function un1tDealDates(stageSlug, evidence, now = Date.now()) {
  const stage = un1tStageEnteredAt(stageSlug, evidence, now)
  const funnel = un1tFunnelEnteredAt(evidence, now)
  const createdMs = earliestMs([funnel, stage])
  return {
    created_at: createdMs == null ? null : new Date(createdMs).toISOString(),
    stage_entered_at: stage,
  }
}
