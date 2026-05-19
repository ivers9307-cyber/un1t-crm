// APPROVALS.1 provider — contractor invoices awaiting approval.
//
// Source: contractor_invoices.status='submitted' (mig 101). Master
// sees all; owner sees their locations; everyone else gets nothing
// (managers don't approve contractor invoices — finance surface).

import { userIsMaster, ownerLocationIds } from '../registry'

export const contractorInvoicesProvider = {
  key: 'contractor_invoices',
  label: 'Contractor invoices',
  reviewBase: '/schedule/invoices',

  async fetchPending(db, user) {
    const isMaster = userIsMaster(user)
    const owners = ownerLocationIds(user)
    if (!isMaster && owners.length === 0) return { count: 0, items: [] }

    let q = db
      .from('contractor_invoices')
      .select(`
        id, period_start, period_end, invoice_amount, invoice_number,
        created_at, location_id,
        contractor:contractor_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'submitted')
      .order('created_at', { ascending: false })
      .limit(50)

    if (!isMaster) q = q.in('location_id', owners)

    const { data, error } = await q
    if (error) throw new Error(`contractor_invoices: ${error.message}`)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: r.contractor?.full_name || 'Contractor',
      subtitle: `Period ${r.period_start} → ${r.period_end}${r.invoice_number ? ` · #${r.invoice_number}` : ''}`,
      meta: r.location?.name || null,
      submittedAt: r.created_at,
      amount: Number(r.invoice_amount) || null,
      currency: 'EUR',
      reviewUrl: `/schedule/invoices?focus=${r.id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const isMaster = userIsMaster(user)
    const owners = ownerLocationIds(user)
    if (!isMaster && owners.length === 0) return 0
    let q = db
      .from('contractor_invoices')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'submitted')
    if (!isMaster) q = q.in('location_id', owners)
    const { count, error } = await q
    if (error) throw new Error(`contractor_invoices count: ${error.message}`)
    return count || 0
  },
}
