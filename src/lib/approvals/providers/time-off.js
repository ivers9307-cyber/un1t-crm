// APPROVALS.1 provider — time-off requests awaiting approval.
//
// Source: time_off_requests.status='pending' (mig 011). Schedule-
// approver scope: manager / head_coach / owner / master can
// approve; staff cannot.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.
// Switching studio = switching what /approvals shows.

import {
  canApproveAtActiveLocation,
  viewerActiveLocationId,
} from '../registry'

const SCHEDULE_APPROVER_ROLES = ['manager', 'head_coach', 'owner']

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
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canApproveAtActiveLocation(user, SCHEDULE_APPROVER_ROLES)) {
      return { count: 0, items: [] }
    }

    const q = db
      .from('time_off_requests')
      .select(`
        id, type, start_date, end_date, total_days, reason,
        created_at, location_id,
        profile:profile_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'pending')
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
      .limit(50)

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
      // APPROVALS-LOCATION-SCOPE — the active-location filter at the
      // provider level already guarantees the request and the viewer
      // share an active location, so a bare `?focus=<id>` lands on
      // the right list. The location_id query param previously
      // overrode user.activeLocation but is no longer needed.
      reviewUrl: `/schedule/time-off?focus=${r.id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    if (!canApproveAtActiveLocation(user, SCHEDULE_APPROVER_ROLES)) return 0
    const q = db
      .from('time_off_requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')
      .eq('location_id', activeId)
    const { count, error } = await q
    if (error) throw new Error(`time_off_requests count: ${error.message}`)
    return count || 0
  },
}
