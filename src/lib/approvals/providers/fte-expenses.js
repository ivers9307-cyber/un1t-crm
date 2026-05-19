// APPROVALS.1 provider — FTE expense claims awaiting approval.
//
// Source: fte_expense_claims.status='submitted' (mig 183). Same
// approver scope as contractor invoices — master + owner only.

import { userIsMaster, ownerLocationIds } from '../registry'

export const fteExpensesProvider = {
  key: 'fte_expenses',
  label: 'Employee expenses',
  reviewBase: '/schedule/expenses',

  async fetchPending(db, user) {
    const isMaster = userIsMaster(user)
    const owners = ownerLocationIds(user)
    if (!isMaster && owners.length === 0) return { count: 0, items: [] }

    let q = db
      .from('fte_expense_claims')
      .select(`
        id, period_start, period_end, total_amount, item_count,
        submitted_at, location_id,
        profile:profile_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false })
      .limit(50)

    if (!isMaster) q = q.in('location_id', owners)

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
    const isMaster = userIsMaster(user)
    const owners = ownerLocationIds(user)
    if (!isMaster && owners.length === 0) return 0
    let q = db
      .from('fte_expense_claims')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'submitted')
    if (!isMaster) q = q.in('location_id', owners)
    const { count, error } = await q
    if (error) throw new Error(`fte_expense_claims count: ${error.message}`)
    return count || 0
  },
}
