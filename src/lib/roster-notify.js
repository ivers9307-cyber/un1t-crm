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

import { sendPush } from './push'
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
 * Insert per-profile schedule_notifications rows + send push
 * notifications to staff whose shifts were just published.
 *
 * Best-effort. Failures are logged, not thrown — we never want
 * notification trouble to roll back a publish that already
 * succeeded at the data layer.
 *
 * @param {SupabaseClient} db
 * @param {object[]} shifts  Rows just flipped to published, with
 *                           at least { id, profile_id, location_id,
 *                           shift_date }.
 * @param {object} range     { startDate, endDate, locationId }
 */
export async function notifyStaffOfPublish(db, shifts, { startDate, endDate, locationId }) {
  if (!shifts || shifts.length === 0) return { notified: 0 }

  const profileShifts = {}
  for (const s of shifts) {
    if (!profileShifts[s.profile_id]) profileShifts[s.profile_id] = []
    profileShifts[s.profile_id].push(s)
  }

  const notifications = Object.entries(profileShifts).map(([profileId, pShifts]) => ({
    profile_id: profileId,
    shift_id: pShifts[0].id,
    type: 'roster_published',
    channel: 'email',
    metadata: {
      week_start: startDate,
      week_end: endDate,
      shift_count: pShifts.length,
    },
  }))

  // ROSTER-FIX.8f — a PostgREST failure RESOLVES with an `error` property, it
  // does not throw, so this try/catch could never fire and a failed insert was
  // silent. Mig 603 gives schedule_notifications.shift_id a real FK to
  // shift_assignments, which makes a 23503 genuinely reachable here: the
  // representative assignment can be deleted (D4's approved swap-drop) between
  // the notify-list read and this insert. Still best-effort — the push below is
  // the notification, this row is only the record that it was sent.
  const { error: insertError } = await db.from('schedule_notifications').insert(notifications)
  if (insertError) {
    logWarn('roster-notify', 'notification log insert failed', { err: insertError.message })
  }

  const userIds = Object.keys(profileShifts)
  if (userIds.length) {
    const rangeLabel = startDate === endDate ? startDate : `${startDate} – ${endDate}`
    sendPush(userIds, {
      title: 'New schedule published',
      body: `Your shifts for ${rangeLabel} are live. Tap to view.`,
      category: 'schedule',
      data: {
        type: 'schedule_published',
        start_date: startDate,
        end_date: endDate,
        location_id: locationId,
      },
    }).catch(err => console.error('[roster-notify] push failed', err))
  }

  return { notified: userIds.length }
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
 * `notifyUsers` under the `schedule` category, which (unlike
 * `shift_adjusted`) has no email fallback, so a coach with no push token
 * gets nothing here. Every collected row is stamped notified regardless of
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
