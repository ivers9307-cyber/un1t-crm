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
