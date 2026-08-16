// OFFERS.6 provider — paid sale-offer purchases awaiting Glofox fulfilment.
//
// Source: offer_purchases.state='paid' AND fulfilled_at IS NULL (mig 503).
// A row appears the moment the Revolut webhook (or the status-poll recheck)
// marks the purchase paid, and clears when staff hit "Mark fulfilled" on
// /offer-sales after setting the member up in Glofox.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.
// TENANT.8 (item 4) — every row this provider returns is eq('location_id',
// activeId)-filtered to the VIEWER'S OWN active location, so the registry's
// bundlesDenyCategory(user.activeLocation.features, key) check already
// covers every row here. No per-row location-features query needed —
// unlike host_events (org-scoped, can return rows from OTHER locations).

import { viewerActiveLocationId } from '../registry'
import { formatEuro } from '@/lib/sale-offers'

export const offerPurchasesProvider = {
  key: 'offer_purchases',
  permissionKey: 'approvals_offer_purchases',
  label: 'Offer sales',
  reviewBase: '/offer-sales',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }

    const { data, error } = await db
      .from('offer_purchases')
      .select(`
        id, buyer_name, buyer_email, amount_cents, currency, paid_at, location_id,
        offer:offer_id ( id, name, bonus_headline ),
        location:location_id ( id, name )
      `)
      .eq('state', 'paid')
      .is('fulfilled_at', null)
      .eq('location_id', activeId)
      .order('paid_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(`offer_purchases: ${error.message}`)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: r.buyer_name || r.buyer_email || 'Buyer',
      subtitle: `${r.offer?.name || 'Offer'} · ${formatEuro(r.amount_cents || 0)}`,
      meta: r.location?.name || null,
      submittedAt: r.paid_at,
      amount: (r.amount_cents || 0) / 100,
      currency: r.currency || 'EUR',
      reviewUrl: `/offer-sales?focus=${r.id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const { count, error } = await db
      .from('offer_purchases')
      .select('*', { count: 'exact', head: true })
      .eq('state', 'paid')
      .is('fulfilled_at', null)
      .eq('location_id', activeId)
    if (error) throw new Error(`offer_purchases count: ${error.message}`)
    return count || 0
  },
}
