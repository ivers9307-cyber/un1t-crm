// LEAVECANCEL.1 provider — requests to cancel APPROVED leave, waiting for an
// owner.
//
// Source: time_off_requests rows that are an OPEN ask (mig 624):
// status='approved', cancel_requested_at set, cancel_decided_at NULL, and the
// leave not yet over. The leave itself is still approved and in force; this is
// the queue of "may I have it back?".
//
// WHY ITS OWN PROVIDER, NOT A SECOND ITEM KIND INSIDE `time_off`:
//   • WHO SEES IT IS DIFFERENT. `time_off` gates on the approvals_time_off
//     PERMISSION, which managers and head coaches hold. This decision is
//     ROLE-based by the owner's rule (an owner at a studio the request belongs
//     to, or a master), and the registry gates a provider as a whole. An item
//     a manager can see and count but whose decide route answers 403 is the
//     "count gate ≠ row gate" trap, one level down.
//   • THE PHONE. mobile/lib/approvals.js renders every `time_off` item as a
//     decide card whose Approve / Decline send { status } to
//     PUT /api/schedule/time-off/[id]. On one of THESE rows Decline would set
//     approved leave to `rejected`: the opposite of what the button says, on a
//     phone that has not taken an update yet. An unknown provider key is
//     neither rendered nor counted there, so old and new phones alike simply
//     do not show it. Deciding on the phone is out of scope for LEAVECANCEL.1.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation, person-scoped the
// same way the leave queue is (LEAVE.2): filed at the active studio OR asked by
// anyone who belongs to it. isVisible requires OWNER AT THE ACTIVE STUDIO, and
// the active studio is by construction one the request belongs to, so everyone
// who is shown a row can decide it (canDecideLeaveCancel agrees). The viewer's
// own ask is excluded: nobody decides their own.
//
// No permissionKey on purpose: the registry treats permissionKey and
// isVisible() as EITHER/OR. The bundle layer still applies through
// CATEGORY_BUNDLES.time_off_cancellations (bundle_team, as time_off).

import { viewerActiveLocationId, canApproveAtActiveLocation } from '../registry'
import { dublinTodayStr } from '@/lib/dublin-time'
import { getLocationMemberIds, leaveScopeOrFilter } from '@/lib/time-off-leave'
import { applyOpenCancelAskFilter, LEAVE_CANCEL_DECIDER_ROLES } from '@/lib/time-off-cancel'
import { timeOffLeaveLabel } from '@shared/time-off'

async function scopeFilter(db, activeId) {
  const { ids, error } = await getLocationMemberIds(db, [activeId])
  if (error) throw new Error(`profile_locations: ${error.message}`)
  return leaveScopeOrFilter([activeId], ids)
}

// Master, or OWNER at the active studio (canApproveAtActiveLocation handles both).
const canDecideHere = (user) => canApproveAtActiveLocation(user, LEAVE_CANCEL_DECIDER_ROLES)

export const timeOffCancellationsProvider = {
  key: 'time_off_cancellations',
  label: 'Leave cancellations',
  reviewBase: '/schedule/time-off',
  // Decided on the web Time Off page only. The phone ignores this key, so the
  // phone-side count (the iOS widget, via getHomeQueueCounts) must not include
  // it. REMOVE this flag when the phone ships a surface for it.
  noPhoneSurface: true,

  isVisible(user) {
    return canDecideHere(user)
  },

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    // Re-checked here, not only in isVisible: a direct caller gets nothing.
    if (!activeId || !canDecideHere(user)) return { count: 0, items: [] }

    const q = applyOpenCancelAskFilter(
      db
        .from('time_off_requests')
        .select(`
          id, type, status, start_date, end_date, total_days,
          cancel_requested_at, cancel_request_note, location_id, profile_id,
          profile:profile_id ( id, full_name ),
          location:location_id ( id, name )
        `)
        .or(await scopeFilter(db, activeId))
        .neq('profile_id', user.id),
      dublinTodayStr(),
    )
      .order('cancel_requested_at', { ascending: true })
      .limit(50)

    const { data, error } = await q
    if (error) throw new Error(`time_off_requests (cancellations): ${error.message}`)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: r.profile?.full_name || 'Employee',
      subtitle: `Cancel approved leave · ${timeOffLeaveLabel(r.type)} · ${r.start_date} → ${r.end_date} (${r.total_days} day${Number(r.total_days) === 1 ? '' : 's'})${r.cancel_request_note ? ` · "${r.cancel_request_note}"` : ''}`,
      meta: r.location?.name || null,
      submittedAt: r.cancel_requested_at,
      amount: null,
      currency: null,
      // view=cancellations lands the Time Off page on Team + Approved, where
      // this row lives (a bare ?focus= lands on Pending, where it does not).
      reviewUrl: `/schedule/time-off?focus=${r.id}&view=cancellations`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId || !canDecideHere(user)) return 0
    const q = applyOpenCancelAskFilter(
      db
        .from('time_off_requests')
        .select('*', { count: 'exact', head: true })
        .or(await scopeFilter(db, activeId))
        .neq('profile_id', user.id),
      dublinTodayStr(),
    )
    const { count, error } = await q
    if (error) throw new Error(`time_off_requests (cancellations) count: ${error.message}`)
    return count || 0
  },
}
