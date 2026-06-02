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
    .select('id, profile_id, shift_blocks!block_id(location_id, block_date)')
    .in('block_id', blockIds)
  if (error) {
    logWarn('roster-notify', 'publishNotifyRowsForBlocks query failed', { err: error })
    return []
  }
  return (data || [])
    .filter((a) => a.shift_blocks)
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

  try {
    await db.from('schedule_notifications').insert(notifications)
  } catch (e) {
    logWarn('roster-notify', `notification log insert failed`, { err: e })
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
