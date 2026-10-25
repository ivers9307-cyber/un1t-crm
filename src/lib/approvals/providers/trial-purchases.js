// PAIDTRIAL.2 provider — paid trial purchases whose Glofox grant needs a hand.
//
// Two kinds of card share this tab (TRIALSTUDIO.8):
//   grant  status='needs_review': see below.
//   help   status='help_requested': nobody paid (payment_status null). The
//          public /trial page filed it because a Stillorgan buyer refused for
//          a past trial pressed "I need help", a Hatch buyer was refused for
//          an active membership, or un1t.online could not give a Hatch buyer
//          an account/checkout. Staff ring the buyer, then press Mark handled.
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

// Both kinds in one PostgREST or(): every help request, and a needs_review
// row only once it is paid (an unpaid one is not staff's to grant).
const PENDING_FILTER = 'status.eq.help_requested,and(status.eq.needs_review,payment_status.eq.paid)'

const COLS = 'id, customer_name, customer_email, customer_phone, product_name, amount_cents, currency, duration_days, paid_at, created_at, status, last_error, "grant", glofox_member_id, contact_id, attempts, location_id, location:location_id ( id, name )'

/** 'grant_refused: NO_CREDITS' → { reason: 'grant_refused', detail: 'NO_CREDITS' } */
export function splitReviewError(lastError) {
  const s = String(lastError || '').trim()
  if (!s) return { reason: '', detail: '' }
  const i = s.indexOf(':')
  if (i < 0) return { reason: s, detail: '' }
  return { reason: s.slice(0, i).trim(), detail: s.slice(i + 1).trim() }
}

// A help row whose re-run found nothing ('<prefix>: none_found'): the buyer
// pressed "I need help" though the CRM holds no reason to refuse them, so
// "already had a trial" / "already holds a membership" would be untrue.
const NONE_FOUND_WHY = Object.freeze({
  trial_used: 'The buyer asked for help on the trial page; the CRM found no trial history.',
  active_member: 'The buyer asked for help on the trial page; the CRM found no active membership.',
})
const noneFoundWhy = (reason, detail) => (detail === 'none_found' ? NONE_FOUND_WHY[reason] || null : null)

/** Operator copy for a review row: the reason's sentence plus Glofox's words. */
export function reviewWhy(row) {
  const { reason, detail } = splitReviewError(row?.last_error)
  const none = noneFoundWhy(reason, detail)
  if (none) return none
  const base = REVIEW_REASONS[reason] || (reason ? `Stopped with: ${reason}` : 'The plan was not put on the account.')
  return detail ? `${base} (${detail})` : base
}

/** A help row's sentence alone: the reasons are listed separately on the card. */
function helpWhy(row) {
  const { reason, detail } = splitReviewError(row?.last_error)
  return noneFoundWhy(reason, detail)
    || REVIEW_REASONS[reason] || (reason ? `Stopped with: ${reason}` : 'The buyer asked for help.')
}

/** A marker with no outcome means Glofox may already hold the plan: never buy again blind. */
export function grantMayHaveLanded(row) {
  const g = row?.grant
  return !!(g && typeof g === 'object' && g.stage === 'purchasing' && g.ok == null && !g.outcome_unknown) || !!(g && g.outcome_unknown)
}

/** The help row's last_error is '<prefix>: <reason>, <reason>'; the reasons as a list. */
function helpReasons(lastError) {
  const { detail } = splitReviewError(lastError)
  return detail ? detail.split(', ').map((x) => x.trim()).filter(Boolean) : []
}

export function toItem(r) {
  const help = r.status === 'help_requested'
  return {
    kind: help ? 'help' : 'grant',
    reasons: help ? helpReasons(r.last_error) : [],
    id: r.id,
    title: r.customer_name || r.customer_email || 'Buyer',
    subtitle: `${r.product_name || 'Trial'} · ${formatTrialPrice(r.amount_cents || 0, r.currency || 'EUR')} · ${r.duration_days || 14} days`,
    meta: r.location?.name || null,
    submittedAt: help ? r.created_at : r.paid_at,
    amount: (r.amount_cents || 0) / 100,
    currency: r.currency || 'EUR',
    reviewUrl: `/approvals?focus=${r.id}`,
    // card fields
    email: r.customer_email || null,
    phone: r.customer_phone || null,
    contactId: r.contact_id || null,
    glofoxMemberId: r.glofox_member_id || null,
    attempts: r.attempts || 0,
    why: help ? helpWhy(r) : reviewWhy(r),
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
      .or(PENDING_FILTER)
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
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
      .or(PENDING_FILTER)
      .eq('location_id', activeId)
    if (error) throw new Error(`trial_purchases count: ${error.message}`)
    return count || 0
  },
}
