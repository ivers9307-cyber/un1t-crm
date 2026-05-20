// APPROVALS.1 provider — contractor invoices awaiting approval.
//
// Source: contractor_invoices.status='submitted' (mig 101). Owner +
// master can approve at their active location; everyone else gets
// nothing (managers don't approve contractor invoices — finance
// surface).
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.

import { canApproveAtActiveLocation, viewerActiveLocationId } from '../registry'

const FINANCE_APPROVER_ROLES = ['owner']

export const contractorInvoicesProvider = {
  key: 'contractor_invoices',
  label: 'Contractor invoices',
  reviewBase: '/schedule/invoices',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) {
      return { count: 0, items: [] }
    }

    const q = db
      .from('contractor_invoices')
      .select(`
        id, period_start, period_end, invoice_amount, invoice_number,
        created_at, location_id,
        contractor:contractor_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'submitted')
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
      .limit(50)

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
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) return 0
    const q = db
      .from('contractor_invoices')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'submitted')
      .eq('location_id', activeId)
    const { count, error } = await q
    if (error) throw new Error(`contractor_invoices count: ${error.message}`)
    return count || 0
  },
}
