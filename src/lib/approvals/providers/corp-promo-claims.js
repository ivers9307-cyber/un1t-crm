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
//
// WAYSIN.2: a card's platform is the claim's own platform column (mig 816); a
// row written before it was stamped falls back to ONE read of the studio's
// corp_promos rows. A failed fallback read leaves platform null on those
// cards (logged), never the tab empty.
import { viewerActiveLocationId } from '../registry'
import { listCorpPromos } from '@/lib/corp-promos-db'
import { logWarn } from '@/lib/log'

const COLS = 'id, first_name, last_name, customer_email, customer_phone, promo_key, platform, reason, created_at, contact_id, un1t_user_id, glofox_member_id, grant, location_id, location:location_id ( id, name )'

const WHY = Object.freeze({
  un1t_promo_unverified: 'un1t.online did not answer clearly and no credits show on the account. Check the account before adding any.',
})

// A stalled claim may have bought only if it got as far as recording a grant.
const grantStarted = (grant) => !!grant && typeof grant === 'object' && !!(grant.stage || grant.outcome)

/**
 * The card's sentence for a claim's reason code (grant: the row's grant jsonb).
 * OPENWEEK.5 — `planName` is the promo's own Glofox plan (corp_promos
 * glofox_plan_name); without it the card says "the promo's plan", never a
 * plan of another promo.
 */
export function claimWhy(reason, grant = null, { planName = null } = {}) {
  const plan = typeof planName === 'string' && planName.trim() ? planName.trim() : null
  const r = String(reason || '')
  if (WHY[r]) return WHY[r]
  if (r.startsWith('un1t_account_refused')) return `un1t.online could not give them an account (${r.split(':').slice(1).join(':').trim() || 'no reason given'}). Nothing was granted.`
  if (r.startsWith('un1t_promo_failed')) return `un1t.online refused the credits (${r.split(':').slice(1).join(':').trim() || 'no reason given'}). Nothing was granted.`
  const detail = r.split(':').slice(1).join(':').trim() || 'no reason given'
  const code = r.split(':')[0]
  if (code === 'glofox_not_configured') return 'Glofox is not connected at this studio, so nothing was tried or bought.'
  if (code === 'live_plan') return `They already hold a live plan or credits at Stillorgan in Glofox. Nothing was bought. Check their account and add ${plan || "the promo's plan"} by hand only if that is right.`
  if (code === 'glofox_read_failed') return 'We could not read their Glofox account. Nothing was bought.'
  if (code === 'grant_refused') return `Glofox refused ${plan ? `the ${plan} plan` : "the promo's plan"} (${detail}). Nothing was bought.`
  if (code === 'grant_unrecorded') return 'We could not record the Glofox purchase, so nothing was bought.'
  if (code === 'stalled' && !grantStarted(grant)) return 'The claim stopped before anything was bought. Nothing was bought.'
  if (code === 'grant_unverified' || code === 'stalled') return `The plan purchase in Glofox may have gone through. Check the member's €0 ${plan ? `${plan} ` : ''}invoice in Glofox before adding the plan by hand.`
  if (code === 'account_needs_review') return `We could not choose their Glofox account safely (${detail}). Nothing was bought.`
  if (code === 'account_create_failed') return `We could not find or create their Glofox account (${detail}). Nothing was bought.`
  return r ? `Stopped with: ${r}` : 'The free credits were not put on the account.'
}

/**
 * One card. `promoPlatforms`: key -> platform from the studio's promos, for rows
 * with no platform; `promoPlans`: key -> Glofox plan name (OPENWEEK.5).
 */
export function toItem(r, promoPlatforms = null, promoPlans = null) {
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
    glofoxMemberId: r.glofox_member_id || null,
    platform: r.platform || promoPlatforms?.get(r.promo_key) || null,
    checkInvoice: /^grant_unverified/.test(String(r.reason || '')) || (/^stalled/.test(String(r.reason || '')) && grantStarted(r.grant)),
    why: claimWhy(r.reason, r.grant, { planName: promoPlans?.get(r.promo_key) || null }),
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
    const rows = data || []
    let promoPlatforms = null
    let promoPlans = null
    // One read of the studio's promos when a card needs it: a row with no
    // platform, or a Glofox row (its card names the promo's plan).
    if (rows.some((r) => !r.platform || r.platform === 'glofox')) {
      const res = await listCorpPromos(db, { locationId: activeId })
      if (res.ok) {
        promoPlatforms = new Map(res.promos.map((p) => [p.key, p.platform]))
        promoPlans = new Map(res.promos.filter((p) => p.glofox?.planName).map((p) => [p.key, p.glofox.planName]))
      } else logWarn('approvals', 'corp promos unreadable; platform and plan unknown on those cards', { locationId: activeId })
    }
    const items = rows.map((r) => toItem(r, promoPlatforms, promoPlans))
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
