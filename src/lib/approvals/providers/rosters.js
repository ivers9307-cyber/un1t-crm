// APPROVALS.1 provider — over-budget rosters awaiting owner sign-off.
//
// Source: rosters.status='draft' (the existing /schedule/approvals
// queue). A manager publishes a draft that's over the location's
// monthly contractor budget → owner needs to approve before it
// goes live. Owner + master only.

import { userIsMaster, ownerLocationIds } from '../registry'

export const rostersProvider = {
  key: 'rosters',
  label: 'Roster approvals',
  reviewBase: '/schedule/approvals',

  async fetchPending(db, user) {
    const isMaster = userIsMaster(user)
    const owners = ownerLocationIds(user)
    if (!isMaster && owners.length === 0) return { count: 0, items: [] }

    let q = db
      .from('rosters')
      .select(`
        id, period_start, period_end, projected_contractor_eur,
        budget_at_publish_eur, created_at, location_id,
        published_by_profile:published_by ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(50)

    if (!isMaster) q = q.in('location_id', owners)

    const { data, error } = await q
    if (error) throw new Error(`rosters: ${error.message}`)

    const items = (data || []).map((r) => {
      const projected = Number(r.projected_contractor_eur) || 0
      const budget = Number(r.budget_at_publish_eur) || 0
      const overrun = projected - budget
      const publisher = r.published_by_profile?.full_name || 'Manager'
      return {
        id: r.id,
        title: `${r.period_start} → ${r.period_end}`,
        subtitle: `Published by ${publisher} · €${projected.toFixed(0)} projected vs €${budget.toFixed(0)} budget${overrun > 0 ? ` (+€${overrun.toFixed(0)} over)` : ''}`,
        meta: r.location?.name || null,
        submittedAt: r.created_at,
        amount: overrun > 0 ? overrun : null,
        currency: 'EUR',
        reviewUrl: `/schedule/approvals?focus=${r.id}`,
      }
    })
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const isMaster = userIsMaster(user)
    const owners = ownerLocationIds(user)
    if (!isMaster && owners.length === 0) return 0
    let q = db
      .from('rosters')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'draft')
    if (!isMaster) q = q.in('location_id', owners)
    const { count, error } = await q
    if (error) throw new Error(`rosters count: ${error.message}`)
    return count || 0
  },
}
