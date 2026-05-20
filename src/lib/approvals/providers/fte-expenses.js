// APPROVALS.1 provider — FTE expense claims awaiting approval.
//
// Source: fte_expense_claims.status='submitted' (mig 183). Same
// approver scope as contractor invoices — owner + master only.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.

import { canApproveAtActiveLocation, viewerActiveLocationId } from '../registry'

const FINANCE_APPROVER_ROLES = ['owner']

export const fteExpensesProvider = {
  key: 'fte_expenses',
  label: 'Employee expenses',
  reviewBase: '/schedule/expenses',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) {
      return { count: 0, items: [] }
    }

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
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) return 0
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
