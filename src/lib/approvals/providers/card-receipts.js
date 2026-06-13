// APPROVALS provider — company-card receipts awaiting approval (SPEND.P3).
//
// Source: card_receipts.status='submitted' (mig 266). Owner + master
// approve at their active location — the same finance-approver gate as
// contractor invoices (managers don't approve, even though a manager
// may be the submitter). Scoped to user.activeLocation.

import { canApproveAtActiveLocation, viewerActiveLocationId } from '../registry'

const FINANCE_APPROVER_ROLES = ['owner']

export const cardReceiptsProvider = {
  key: 'card_receipts',
  label: 'Company-card receipts',
  reviewBase: '/card-receipts',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) {
      return { count: 0, items: [] }
    }

    const { data, error } = await db
      .from('card_receipts')
      .select(`
        id, purchase_date, amount, merchant, card_last4, submitted_at, location_id,
        submitter:submitter_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'submitted')
      .eq('location_id', activeId)
      .order('submitted_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(`card_receipts: ${error.message}`)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: r.submitter?.full_name || 'Card holder',
      subtitle: `${r.merchant || 'Company-card purchase'} · ${r.purchase_date}${r.card_last4 ? ` · ••${r.card_last4}` : ''}`,
      meta: r.location?.name || null,
      submittedAt: r.submitted_at,
      amount: Number(r.amount) || null,
      currency: 'EUR',
      reviewUrl: `/card-receipts?focus=${r.id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) return 0
    const { count, error } = await db
      .from('card_receipts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'submitted')
      .eq('location_id', activeId)
    if (error) throw new Error(`card_receipts count: ${error.message}`)
    return count || 0
  },
}
