// PAIDTRIAL.2 provider — paid trial purchases whose Glofox grant needs a hand.
//
// Source: trial_purchases.status='needs_review' (mig 762): the money is in
// (payment_status='paid') but the processor could not put the plan on the
// account (Glofox refused, no clear answer, the account could not be chosen
// safely, …). The row leaves the queue when staff press Retry (the processor
// runs again) or Mark granted (they did it by hand in Glofox), both through
// POST /api/trial-purchases/[id]/review. The ops alert email still goes
// out; this is the in-app surface Richard asked for after the first live
// purchase (21 Oct 2026) landed here with nothing to click.
//
// Permission: the same approvals_offer_purchases grant as the paid sale
// offers, which is the same job (a paid purchase awaiting Glofox
// fulfilment) for the same people; no new permission key.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only (every row
// is eq('location_id', activeId)-filtered, so the registry's bundle check
// covers it; TENANT.8 item 4).
//
// Decided on the web /approvals tab only: the phone neither renders nor
// counts this key (noPhoneSurface, like time_off_cancellations).

import { viewerActiveLocationId } from '../registry'
import { REVIEW_REASONS } from '@/lib/trial-purchase-processor'
import { formatTrialPrice } from '@/lib/paid-trial'

const COLS = 'id, customer_name, customer_email, customer_phone, product_name, amount_cents, currency, duration_days, paid_at, status, last_error, "grant", glofox_member_id, contact_id, attempts, location_id, location:location_id ( id, name )'

/** 'grant_refused: NO_CREDITS' → { reason: 'grant_refused', detail: 'NO_CREDITS' } */
export function splitReviewError(lastError) {
  const s = String(lastError || '').trim()
  if (!s) return { reason: '', detail: '' }
  const i = s.indexOf(':')
  if (i < 0) return { reason: s, detail: '' }
  return { reason: s.slice(0, i).trim(), detail: s.slice(i + 1).trim() }
}

/** Operator copy for a review row: the reason's sentence plus Glofox's words. */
export function reviewWhy(row) {
  const { reason, detail } = splitReviewError(row?.last_error)
  const base = REVIEW_REASONS[reason] || (reason ? `Stopped with: ${reason}` : 'The plan was not put on the account.')
  return detail ? `${base} (${detail})` : base
}

/** A marker with no outcome means Glofox may already hold the plan: never buy again blind. */
export function grantMayHaveLanded(row) {
  const g = row?.grant
  return !!(g && typeof g === 'object' && g.stage === 'purchasing' && g.ok == null && !g.outcome_unknown) || !!(g && g.outcome_unknown)
}

export function toItem(r) {
  return {
    id: r.id,
    title: r.customer_name || r.customer_email || 'Buyer',
    subtitle: `${r.product_name || 'Trial'} · ${formatTrialPrice(r.amount_cents || 0, r.currency || 'EUR')} · ${r.duration_days || 14} days`,
    meta: r.location?.name || null,
    submittedAt: r.paid_at,
    amount: (r.amount_cents || 0) / 100,
    currency: r.currency || 'EUR',
    reviewUrl: `/approvals?focus=${r.id}`,
    // card fields
    email: r.customer_email || null,
    phone: r.customer_phone || null,
    contactId: r.contact_id || null,
    glofoxMemberId: r.glofox_member_id || null,
    attempts: r.attempts || 0,
    why: reviewWhy(r),
    mayHaveLanded: grantMayHaveLanded(r),
  }
}

export const trialPurchasesProvider = {
  key: 'trial_purchases',
  permissionKey: 'approvals_offer_purchases',
  label: 'Paid trials',
  reviewBase: '/approvals',
  noPhoneSurface: true,

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    const { data, error } = await db
      .from('trial_purchases')
      .select(COLS)
      .eq('status', 'needs_review')
      .eq('payment_status', 'paid')
      .eq('location_id', activeId)
      .order('paid_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(`trial_purchases: ${error.message}`)
    const items = (data || []).map(toItem)
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const { count, error } = await db
      .from('trial_purchases')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'needs_review')
      .eq('payment_status', 'paid')
      .eq('location_id', activeId)
    if (error) throw new Error(`trial_purchases count: ${error.message}`)
    return count || 0
  },
}
