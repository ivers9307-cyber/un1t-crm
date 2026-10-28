// CORPPROMO.1 provider — /corp promo claims whose free credits could not be
// put on the person's un1t.online account automatically.
//
// Source: corp_promo_claims.status='help_requested' (mig 787): un1t.online
// refused the account or the grant, or answered unclearly, so nothing is
// known to be on the account. Nobody was charged (a promo never charges).
// Staff check the account in un1t.online, add the credits by hand if the
// person qualifies, then press Mark handled (POST
// /api/corp-promo-claims/[id]/handled). The ops alert email still goes out.
//
// Permission: approvals_offer_purchases, the same people who handle the paid
// trial help cards (the same job); no new permission key. Scoped to the
// viewer's active location (every row eq('location_id', activeId)). Decided on
// the web /approvals tab only (noPhoneSurface, like trial_purchases).
import { viewerActiveLocationId } from '../registry'

const COLS = 'id, first_name, last_name, customer_email, customer_phone, promo_key, reason, created_at, contact_id, un1t_user_id, location_id, location:location_id ( id, name )'

const WHY = Object.freeze({
  un1t_promo_unverified: 'un1t.online did not answer clearly and no credits show on the account. Check the account before adding any.',
})

/** The card's sentence for a claim's reason code. */
export function claimWhy(reason) {
  const r = String(reason || '')
  if (WHY[r]) return WHY[r]
  if (r.startsWith('un1t_account_refused')) return `un1t.online could not give them an account (${r.split(':').slice(1).join(':').trim() || 'no reason given'}). Nothing was granted.`
  if (r.startsWith('un1t_promo_failed')) return `un1t.online refused the credits (${r.split(':').slice(1).join(':').trim() || 'no reason given'}). Nothing was granted.`
  return r ? `Stopped with: ${r}` : 'The free credits were not put on the account.'
}

export function toItem(r) {
  const name = `${r.first_name || ''} ${r.last_name || ''}`.trim()
  return {
    kind: 'help',
    id: r.id,
    title: name || r.customer_email || 'Claim',
    subtitle: `Corporate promo · ${r.promo_key}`,
    meta: r.location?.name || null,
    submittedAt: r.created_at,
    amount: null,
    currency: 'EUR',
    reviewUrl: `/approvals?focus=${r.id}`,
    email: r.customer_email || null,
    phone: r.customer_phone || null,
    contactId: r.contact_id || null,
    un1tUserId: r.un1t_user_id || null,
    why: claimWhy(r.reason),
  }
}

export const corpPromoClaimsProvider = {
  key: 'corp_promo_claims',
  permissionKey: 'approvals_offer_purchases',
  label: 'Corporate promos',
  reviewBase: '/approvals',
  noPhoneSurface: true,

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    const { data, error } = await db
      .from('corp_promo_claims')
      .select(COLS)
      .eq('status', 'help_requested')
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(`corp_promo_claims: ${error.message}`)
    const items = (data || []).map(toItem)
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const { count, error } = await db
      .from('corp_promo_claims')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'help_requested')
      .eq('location_id', activeId)
    if (error) throw new Error(`corp_promo_claims count: ${error.message}`)
    return count || 0
  },
}
