// Roster v2 — staff notification fan-out used after a roster
// goes published, regardless of which path got it there:
//
//   - Manager publishes under budget    → /api/schedule/rosters
//                                          (which calls the legacy
//                                          /shifts/publish for notify)
//   - Owner self-publishes over budget   → same as above
//   - Owner approves a draft (manager
//     publish over budget)              → /api/schedule/rosters/[id]/approve
//                                          calls notifyStaffOfPublish() directly
//
// Originally the notification logic lived inline in
// /api/schedule/shifts/publish; extracted here so the
// approval path can reuse it without server-to-server fetch
// gymnastics or double-flipping shifts.published.

import { logWarn } from './log'
import { isLiveAssignment } from './roster'
import { notifyUsers } from './notify'
import { collectUnnotifiedChanges, distinctCoachIds, markChangesNotified } from './roster-change-log'
import { dublinTodayStr } from './dublin-time'
// NOTIFY.1 review — shares the 'Fri 18 Sep' date formatting with the
// moment-of-change messages. One-way import: roster-change-notify.js does
// NOT import this module, so there is no cycle.
import { formatShiftDate } from './roster-change-notify'

/**
 * RETIRE-SHIFTS-MIRROR.6 — build the notify-list for a publish from the
 * Roster v2 model instead of the (now-dropped) public.shifts flip.
 *
 * The publish paths used to capture "which shifts flipped published
 * false→true" to know who to notify. The new-model equivalent of "newly
 * published" is: assignments on the blocks that were just attached to a
 * roster (i.e. had roster_id IS NULL immediately before publish). Callers
 * capture those block ids BEFORE tagging, then pass them here.
 *
 * Returns rows shaped for notifyStaffOfPublish: { id, profile_id,
 * location_id, shift_date }. `id` is the assignment id (it becomes
 * schedule_notifications.shift_id — no longer FK-constrained to shifts).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string[]} blockIds  blocks newly attached to the roster
 * @returns {Promise<object[]>}
 */
export async function publishNotifyRowsForBlocks(db, blockIds) {
  if (!blockIds || blockIds.length === 0) return []
  const { data, error } = await db
    .from('shift_assignments')
    .select('id, profile_id, status, shift_blocks!block_id(location_id, block_date)')
    .in('block_id', blockIds)
  if (error) {
    logWarn('roster-notify', 'publishNotifyRowsForBlocks query failed', { err: error })
    return []
  }
  return (data || [])
    // ROSTER-FIX.1 — a coach whose assignment was cancelled is off the
    // roster; publishing it must not tell them they are working.
    .filter((a) => a.shift_blocks && isLiveAssignment(a))
    .map((a) => ({
      id: a.id,
      profile_id: a.profile_id,
      location_id: a.shift_blocks.location_id,
      shift_date: a.shift_blocks.block_date,
    }))
}

/**
 * Tell every coach whose shifts were just published, and record what actually
 * happened.
 *
 * PUBNOTIFY.1 — this used to be a bare `sendPush` whose schedule_notifications
 * row claimed `channel: 'email'` and never touched `delivered`. Two problems,
 * one of them silent: a coach without the app got NOTHING (the first publish is
 * the one notice that tells them the week exists), and the record of the send
 * described a channel that was never used, so nobody auditing the table could
 * see it. It now goes through `notifyUsers` — the same push-with-email-fallback
 * helper the moment-of-change notices use (NOTIFY.1,
 * src/lib/roster-change-notify.js) — and writes the channel(s) that really
 * carried it plus whether anything landed.
 *
 * Category stays `schedule` (NOT `shift_adjusted`): this is the weekly "your
 * roster is up" notice, it is the category the re-publish safety net
 * (renotifyChangedCoaches) also sends under, and it is the toggle a coach
 * reaches for when they mean "don't tell me about rosters". A coach who turned
 * `schedule` off is left alone — notifyUsers honours the opt-out for the email
 * fallback too, so nothing here goes around their back; their row records
 * channel 'none' with `delivered: false` and the reason, rather than a lie.
 *
 * Per coach rather than one batched call, like notifyRosterChanges: the whole
 * point is to know which channel reached WHICH coach, and a batched total
 * cannot say. One coach's failure never stops the rest.
 *
 * Best-effort. Failures are logged, not thrown — we never want notification
 * trouble to roll back a publish that already succeeded at the data layer.
 *
 * @param {SupabaseClient} db
 * @param {object[]} shifts  Rows just flipped to published, with
 *                           at least { id, profile_id, location_id,
 *                           shift_date }.
 * @param {object} range     { startDate, endDate, locationId }
 * @returns {Promise<{ notified: number, delivered: number }>} `notified` is
 *   coaches TARGETED (unchanged meaning); `delivered` is how many of them a
 *   push or an email actually reached.
 */
export async function notifyStaffOfPublish(db, shifts, { startDate, endDate, locationId }) {
  if (!shifts || shifts.length === 0) return { notified: 0, delivered: 0 }

  const profileShifts = {}
  for (const s of shifts) {
    if (!profileShifts[s.profile_id]) profileShifts[s.profile_id] = []
    profileShifts[s.profile_id].push(s)
  }

  const rangeLabel = startDate === endDate ? startDate : `${startDate} – ${endDate}`
  const title = 'New schedule published'
  const body = `Your shifts for ${rangeLabel} are live. Tap to view.`

  const notifications = []
  let delivered = 0

  for (const [profileId, pShifts] of Object.entries(profileShifts)) {
    let totals = null
    try {
      totals = await notifyUsers([profileId], {
        title,
        body,
        category: 'schedule',
        emailSubject: title,
        data: {
          type: 'schedule_published',
          start_date: startDate,
          end_date: endDate,
          location_id: locationId,
        },
      })
    } catch (err) {
      // notifyUsers is documented never to throw; if it ever does, one coach's
      // failure must not cost the rest of the roster their notification, and
      // the row below still gets written (as an undelivered one).
      logWarn('roster-notify', 'publish notify threw', { profileId, err: err?.message })
    }

    const sent = totals?.sent || 0
    const emailed = totals?.emailed || 0
    const reached = sent + emailed > 0
    if (reached) delivered++

    notifications.push({
      profile_id: profileId,
      shift_id: pShifts[0].id,
      type: 'roster_published',
      channel: deliveryChannel(sent, emailed),
      delivered: reached,
      metadata: {
        week_start: startDate,
        week_end: endDate,
        shift_count: pShifts.length,
        // The raw counts, so an auditor can tell "nobody was listening"
        // (opted out / no device) apart from "we tried and it broke".
        push_sent: sent,
        emails_sent: emailed,
        push_failed: totals?.failed || 0,
        email_failed: totals?.email_failed || 0,
        // push.js counts a master-switch or notify_schedule opt-out as
        // `skipped`; with nothing sent that IS the opt-out, and the coach is
        // deliberately left to the re-publish safety net rather than emailed
        // around.
        opted_out: !reached && (totals?.skipped || 0) > 0,
      },
    })
  }

  // ROSTER-FIX.8f — a PostgREST failure RESOLVES with an `error` property, it
  // does not throw, so this used to sit inside a try/catch that could never
  // fire and a failed insert was silent. Mig 603 gives
  // schedule_notifications.shift_id a real FK to shift_assignments, which makes
  // a 23503 genuinely reachable here: the representative assignment can be
  // deleted (D4's approved swap-drop) between the notify-list read and this
  // insert. Still best-effort — the message above is the notification, this row
  // is only the record that it was sent, so it is written AFTER the send and a
  // lost record never costs a coach their message.
  const { error: insertError } = await db.from('schedule_notifications').insert(notifications)
  if (insertError) {
    logWarn('roster-notify', 'notification log insert failed', { err: insertError.message })
  }

  return { notified: notifications.length, delivered }
}

/**
 * PUBNOTIFY.1 — the value written to schedule_notifications.channel. The column
 * is free text (mig 010 documents "email, whatsapp" and nothing enforces it),
 * so it has to describe what this send did: both channels can carry the same
 * notice when a coach has one stale device and no others, and 'none' is a real
 * outcome (opted out, or no token and no address) that must not be dressed up
 * as a channel.
 */
export function deliveryChannel(pushSent, emailsSent) {
  if (pushSent > 0 && emailsSent > 0) return 'push+email'
  if (pushSent > 0) return 'push'
  if (emailsSent > 0) return 'email'
  return 'none'
}

/**
 * SCHEDULE-CHANGE-LOG.1 / NOTIFY.1 — the re-publish safety net. Changes made
 * to a published roster are now sent at the moment of change
 * (roster-change-notify.js); this picks up whatever that could not deliver
 * (no token and no email, a failed send, or rows from before NOTIFY.1).
 * Called by BOTH publish paths: POST /api/schedule/rosters and
 * POST /api/schedule/rosters/[id]/approve, which never had it, so every
 * over-budget re-publish used to tell nobody. Best-effort; never throws.
 *
 * This is the FINAL attempt for whatever it collects — it sends via
 * `notifyUsers` under the `schedule` category, which since PUBNOTIFY.1 has an
 * email fallback too, so a coach with no push token is emailed rather than
 * silently skipped. Every collected row is stamped notified regardless of
 * delivery, so there is no later retry beyond this call.
 *
 * A collected change row's block_date can be in the past by the time this
 * runs (an old, never-notified row, or a re-publish of a period that has
 * partly elapsed) — a coach must never get a "your shift changed" push for
 * something that already happened. So only coaches with at least one
 * collected change dated today or later get pushed, but EVERY collected row
 * is still stamped notified: a past row needs no message, but leaving it
 * unstamped would just re-surface it (and keep blocking on it) forever.
 *
 * The returned `notified` count is coaches TARGETED (pushed to), not
 * deliveries confirmed — `notifyUsers` is fire-and-forget push, so a token
 * that is stale or unregistered still counts here.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} range
 * @param {string} range.locationId
 * @param {string} range.periodStart
 * @param {string} range.periodEnd
 * @param {string} [range.todayStr]  Dublin 'YYYY-MM-DD' to treat as "today";
 *                                   defaults to dublinTodayStr(). Tests pass
 *                                   this to pin the past/future boundary.
 */
export async function renotifyChangedCoaches(db, { locationId, periodStart, periodEnd, todayStr }) {
  try {
    const today = todayStr || dublinTodayStr()
    const changes = await collectUnnotifiedChanges(db, { locationId, periodStart, periodEnd })
    const futureChanges = changes.filter((c) => c.block_date >= today)
    const coachIds = distinctCoachIds(futureChanges)
    if (coachIds.length > 0) {
      const body = periodStart === periodEnd
        ? `Your shifts for ${formatShiftDate(periodStart)} have been updated.`
        : `Your shifts between ${formatShiftDate(periodStart)} and ${formatShiftDate(periodEnd)} have been updated.`
      await notifyUsers(coachIds, {
        title: 'Roster updated',
        body,
        category: 'schedule',
        data: { type: 'schedule_updated', start_date: periodStart, end_date: periodEnd, location_id: locationId },
      })
    }
    await markChangesNotified(db, changes.map((c) => c.id))
    return { notified: coachIds.length }
  } catch (e) {
    logWarn('roster-notify', 'republish change-notify failed', { locationId, err: e?.message })
    return { notified: 0 }
  }
}
