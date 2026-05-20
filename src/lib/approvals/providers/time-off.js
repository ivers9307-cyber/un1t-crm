// APPROVALS.1 provider — time-off requests awaiting approval.
//
// Source: time_off_requests.status='pending' (mig 011). Schedule-
// approver scope: manager / head_coach / owner / master can
// approve; staff cannot.

import { userIsMaster, scheduleApproverLocationIds } from '../registry'

const TYPE_LABELS = {
  holiday: 'Holiday',
  sick: 'Sick leave',
  unavailable: 'Unavailable',
}

export const timeOffProvider = {
  key: 'time_off',
  label: 'Time off',
  reviewBase: '/schedule/time-off',

  async fetchPending(db, user) {
    const isMaster = userIsMaster(user)
    const approverLocations = scheduleApproverLocationIds(user)
    if (!isMaster && approverLocations.length === 0) return { count: 0, items: [] }

    let q = db
      .from('time_off_requests')
      .select(`
        id, type, start_date, end_date, total_days, reason,
        created_at, location_id,
        profile:profile_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50)

    if (!isMaster) q = q.in('location_id', approverLocations)

    const { data, error } = await q
    if (error) throw new Error(`time_off_requests: ${error.message}`)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: r.profile?.full_name || 'Employee',
      subtitle: `${TYPE_LABELS[r.type] || r.type} · ${r.start_date} → ${r.end_date} (${r.total_days} day${r.total_days === 1 ? '' : 's'})`,
      meta: r.location?.name || null,
      submittedAt: r.created_at,
      amount: null,
      currency: null,
      // APPROVALS-VISIBILITY-FIX — include location_id so TimeOffManager
      // overrides its default of user.activeLocation. Without this, a
      // master drilling in from /approvals lands on their own active
      // location and the request (at a different location) never
      // appears in either tab — so they can't approve it.
      reviewUrl: `/schedule/time-off?focus=${r.id}&location_id=${r.location_id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const isMaster = userIsMaster(user)
    const approverLocations = scheduleApproverLocationIds(user)
    if (!isMaster && approverLocations.length === 0) return 0
    let q = db
      .from('time_off_requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')
    if (!isMaster) q = q.in('location_id', approverLocations)
    const { count, error } = await q
    if (error) throw new Error(`time_off_requests count: ${error.message}`)
    return count || 0
  },
}
