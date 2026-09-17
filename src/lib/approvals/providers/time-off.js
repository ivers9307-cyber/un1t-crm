// APPROVALS.1 provider — time-off requests awaiting approval.
//
// Source: time_off_requests.status='pending' (mig 011). Schedule-
// approver scope: manager / head_coach / owner / master can
// approve; staff cannot.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.
// TENANT.8 (item 4) — every row this provider returns is eq('location_id',
// activeId)-filtered to the VIEWER'S OWN active location, so the registry's
// bundlesDenyCategory(user.activeLocation.features, key) check already
// covers every row here. No per-row location-features query needed —
// unlike host_events (org-scoped, can return rows from OTHER locations).
// Switching studio = switching what /approvals shows.

// LEAVE.2 — two changes to what "pending here" means:
//   • leave covers the person, so the queue is requests filed at the active
//     studio OR by anyone who belongs to it (leaveScopeOrFilter);
//   • a pending request whose end_date has passed has EXPIRED (derived, not
//     stored) and is not in the queue or the count.
// Each item also carries the shift-clash count (LEAVE.1) as `warning`.

import { viewerActiveLocationId } from '../registry'
import { dublinTodayStr } from '@/lib/dublin-time'
import { getLocationMemberIds, leaveScopeOrFilter, countLeaveClashes } from '@/lib/time-off-leave'
import { timeOffLeaveLabel, leaveClashLabel } from '@shared/time-off'

async function scopeFilter(db, activeId) {
  const { ids, error } = await getLocationMemberIds(db, [activeId])
  if (error) throw new Error(`profile_locations: ${error.message}`)
  return leaveScopeOrFilter([activeId], ids)
}

export const timeOffProvider = {
  key: 'time_off',
  permissionKey: 'approvals_time_off',
  label: 'Time off',
  reviewBase: '/schedule/time-off',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    const today = dublinTodayStr()

    const q = db
      .from('time_off_requests')
      .select(`
        id, type, status, start_date, end_date, total_days, reason,
        created_at, location_id, profile_id,
        profile:profile_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .or(await scopeFilter(db, activeId))
      .eq('status', 'pending')
      .gte('end_date', today)
      .order('created_at', { ascending: false })
      .limit(50)

    const { data, error } = await q
    if (error) throw new Error(`time_off_requests: ${error.message}`)

    // Advisory — a failed clash count shows no warning rather than no queue.
    const { counts } = await countLeaveClashes(db, data || [], today)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: r.profile?.full_name || 'Employee',
      subtitle: `${timeOffLeaveLabel(r.type)} · ${r.start_date} → ${r.end_date} (${r.total_days} day${Number(r.total_days) === 1 ? '' : 's'})`,
      meta: r.location?.name || null,
      warning: leaveClashLabel(counts[r.id]),
      clashCount: counts[r.id] || 0,
      submittedAt: r.created_at,
      amount: null,
      currency: null,
      // APPROVALS-LOCATION-SCOPE — a bare `?focus=<id>` lands on the right
      // list: the Time Off page reads the same person-scoped set.
      reviewUrl: `/schedule/time-off?focus=${r.id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const q = db
      .from('time_off_requests')
      .select('*', { count: 'exact', head: true })
      .or(await scopeFilter(db, activeId))
      .eq('status', 'pending')
      .gte('end_date', dublinTodayStr())
    const { count, error } = await q
    if (error) throw new Error(`time_off_requests count: ${error.message}`)
    return count || 0
  },
}
