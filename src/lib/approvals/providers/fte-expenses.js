// APPROVALS.1 provider — FTE expense claims awaiting approval.
//
// Source: fte_expense_claims.status='submitted' (mig 183). Same
// approver scope as contractor invoices — owner + master only.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.
// TENANT.8 (item 4) — every row this provider returns is eq('location_id',
// activeId)-filtered to the VIEWER'S OWN active location, so the registry's
// bundlesDenyCategory(user.activeLocation.features, key) check already
// covers every row here. No per-row location-features query needed —
// unlike host_events (org-scoped, can return rows from OTHER locations).

import { viewerActiveLocationId } from '../registry'

export const fteExpensesProvider = {
  key: 'fte_expenses',
  permissionKey: 'approvals_fte_expenses',
  label: 'Employee expenses',
  reviewBase: '/schedule/expenses',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }

    const q = db
      .from('fte_expense_claims')
      .select(`
        id, period_start, period_end, total_amount, item_count,
        submitted_at, location_id,
        profile:profile_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'submitted')
      .eq('location_id', activeId)
      .order('submitted_at', { ascending: false })
      .limit(50)

    const { data, error } = await q
    if (error) throw new Error(`fte_expense_claims: ${error.message}`)

    const items = (data || []).map((r) => {
      const month = new Date(r.period_start + 'T00:00:00Z')
        .toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      return {
        id: r.id,
        title: r.profile?.full_name || 'Employee',
        subtitle: `${month} · ${r.item_count || 0} item${r.item_count === 1 ? '' : 's'}`,
        meta: r.location?.name || null,
        submittedAt: r.submitted_at,
        amount: Number(r.total_amount) || null,
        currency: 'EUR',
        reviewUrl: `/schedule/expenses?focus=${r.id}`,
      }
    })
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const q = db
      .from('fte_expense_claims')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'submitted')
      .eq('location_id', activeId)
    const { count, error } = await q
    if (error) throw new Error(`fte_expense_claims count: ${error.message}`)
    return count || 0
  },
}
