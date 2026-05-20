// APPROVALS.1 provider — shift swap requests awaiting approval.
//
// Source: shift_swap_requests.status='pending' (mig 010). Same
// approver scope as time-off — manager / head_coach / owner /
// master can approve.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.

import { canApproveAtActiveLocation, viewerActiveLocationId } from '../registry'

const SCHEDULE_APPROVER_ROLES = ['manager', 'head_coach', 'owner']

export const shiftSwapsProvider = {
  key: 'shift_swaps',
  label: 'Shift swaps',
  reviewBase: '/schedule/swaps',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canApproveAtActiveLocation(user, SCHEDULE_APPROVER_ROLES)) {
      return { count: 0, items: [] }
    }

    const q = db
      .from('shift_swap_requests')
      .select(`
        id, reason, created_at, location_id,
        requester:requester_id ( id, full_name ),
        target:target_id ( id, full_name ),
        location:location_id ( id, name ),
        requester_shift:requester_shift_id ( id, start_time, end_time )
      `)
      .eq('status', 'pending')
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
      .limit(50)

    const { data, error } = await q
    if (error) throw new Error(`shift_swap_requests: ${error.message}`)

    const items = (data || []).map((r) => {
      const requester = r.requester?.full_name || 'Coach'
      const target = r.target?.full_name
      const shift = r.requester_shift?.start_time
        ? new Date(r.requester_shift.start_time).toLocaleString('en-IE', {
            weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
          })
        : null
      return {
        id: r.id,
        title: target ? `${requester} ↔ ${target}` : `${requester} (drop)`,
        subtitle: shift ? `Shift: ${shift}` : (r.reason || '—'),
        meta: r.location?.name || null,
        submittedAt: r.created_at,
        amount: null,
        currency: null,
        reviewUrl: `/schedule/swaps?focus=${r.id}`,
      }
    })
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    if (!canApproveAtActiveLocation(user, SCHEDULE_APPROVER_ROLES)) return 0
    const q = db
      .from('shift_swap_requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')
      .eq('location_id', activeId)
    const { count, error } = await q
    if (error) throw new Error(`shift_swap_requests count: ${error.message}`)
    return count || 0
  },
}
