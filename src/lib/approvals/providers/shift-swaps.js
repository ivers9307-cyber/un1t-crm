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
        id, reason, created_at, location_id, status,
        requester:requester_id ( id, full_name ),
        target:target_id ( id, full_name ),
        location:location_id ( id, name ),
        requester_shift:requester_shift_id (
          id, start_time_override,
          shift_blocks!block_id ( block_date, start_time, shift_templates ( name ) )
        )
      `)
      // CT-P3: include awaiting_approval (a coach has claimed/accepted; this is
      // exactly the manager's decision queue). 'pending' open/targeted rows
      // still show so a manager can drop/approve directly.
      .in('status', ['pending', 'awaiting_approval'])
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
      .limit(50)

    const { data, error } = await q
    if (error) throw new Error(`shift_swap_requests: ${error.message}`)

    const items = (data || []).map((r) => {
      const requester = r.requester?.full_name || 'Coach'
      const target = r.target?.full_name
      const blk = r.requester_shift?.shift_blocks
      const tplName = blk?.shift_templates?.name
      const date = blk?.block_date
      const shift = date ? `${tplName ? `${tplName} · ` : ''}${date}` : null
      const claimed = r.status === 'awaiting_approval'
      const base = target ? `${requester} ↔ ${target}` : `${requester} (drop)`
      return {
        id: r.id,
        title: claimed ? `${base} — claimed` : base,
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
      .in('status', ['pending', 'awaiting_approval'])
      .eq('location_id', activeId)
    const { count, error } = await q
    if (error) throw new Error(`shift_swap_requests count: ${error.message}`)
    return count || 0
  },
}
