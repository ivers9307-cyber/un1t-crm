// sale-offers.js — domain logic for the weekend "lock in" sale (OFFERS.*).
//
// The catalogue lives in sale_offers (mig 503) and purchases in
// offer_purchases. Payments ride the shared UN1T Revolut merchant rail
// (src/lib/revolut.js); the webhook route calls markOfferPurchaseState and
// then, fire-and-forget, linkOrCreateContactForPurchase +
// notifyStaffOfPaidPurchase. Prices are only ever read from sale_offers —
// nothing in here accepts a client-supplied amount.

import { findOrCreateRaceContact } from './race-contact-linking'
import { writeContactTag } from './contact-tags'
import { sendOpsAlert } from './ops-alerts'

export const OFFER_SALE_TAG = 'offer-sale-aug-2026'

export function offerIsOpen(offer, now = new Date()) {
  if (!offer?.active) return false
  const t = now.getTime()
  if (t < new Date(offer.starts_at).getTime()) return false
  // GIFTCARD.1 — ends_at NULL means evergreen (a gift card has no deadline).
  // Guard explicitly: new Date(null) is the epoch, not "no end", so the old
  // unconditional comparison would have closed every gift card instantly.
  if (offer.ends_at == null) return true
  return t <= new Date(offer.ends_at).getTime()
}

/** True when this offer is a timed sale (drives countdown + deadline copy). */
export function offerHasDeadline(offer) {
  return Boolean(offer?.ends_at)
}

export function formatEuro(cents) {
  return '€' + (cents / 100).toLocaleString('en-IE', { maximumFractionDigits: 0 })
}

// Human deadline for customer-facing copy, e.g. "MONDAY 10 AUGUST, 23:59".
// DERIVED from the offer's ends_at, never hard-coded — the sale window is
// operator-editable in SQL, and a hard-coded date silently disagrees with
// the live countdown the moment the window moves (it did: the footer read
// "MONDAY 11 AUGUST" while ends_at was a Tuesday). Formats an absolute
// instant into Dublin wall-clock via Intl, so no naive Date parsing.
export function formatSaleDeadline(endsAt, { uppercase = true } = {}) {
  if (!endsAt) return ''
  const d = new Date(endsAt)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  const text = `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`
  return uppercase ? text.toUpperCase() : text
}

export async function resolveOfferPurchaseByOrderId(db, orderId) {
  const { data } = await db
    .from('offer_purchases')
    .select('*, offer:offer_id ( id, slug, name, bonus_headline, price_cents, category )')
    .eq('revolut_order_id', orderId)
    .maybeSingle()
  return data || null
}

// Revolut order states → our purchase states. 'authorised'/'processing' are
// transitional — we only act on terminal states and let the webhook retry
// or the next event settle it.
const STATE_MAP = { completed: 'paid', failed: 'failed', cancelled: 'cancelled' }

export async function markOfferPurchaseState({ db, purchase, providerState }) {
  const next = STATE_MAP[providerState]
  if (!next || purchase.state === next) return { changed: false, state: purchase.state }
  if (purchase.state === 'paid') return { changed: false, state: 'paid' } // never downgrade a paid row
  const patch = { state: next, updated_at: new Date().toISOString() }
  if (next === 'paid' && !purchase.paid_at) patch.paid_at = new Date().toISOString()
  const { error } = await db.from('offer_purchases').update(patch).eq('id', purchase.id)
  if (error) throw new Error(`offer_purchases update: ${error.message}`)
  return { changed: true, state: next }
}

// Resolve the buyer to a CRM contact (org-scoped — the public-form rule from
// LEADCAP.1: contacts_email_unique is GLOBAL, restrictToOrg keeps a known
// email from 500ing and from resolving a stranger's row) and tag them in
// BOTH tag systems (contacts.tags text[] + contact_tags rows).
export async function linkOrCreateContactForPurchase(db, purchase) {
  const contactId = await findOrCreateRaceContact({
    db,
    locationId: purchase.location_id,
    email: purchase.buyer_email,
    name: purchase.buyer_name,
    phone: purchase.buyer_phone,
    restrictToOrg: true,
    insertFields: { lead_source: 'offer_sale' },
  })
  if (!contactId) return { contactId: null }

  await db.from('offer_purchases')
    .update({ contact_id: contactId, updated_at: new Date().toISOString() })
    .eq('id', purchase.id)

  await writeContactTag(db, { contactId, locationId: purchase.location_id, tag: OFFER_SALE_TAG })

  const { data: contact } = await db.from('contacts').select('tags').eq('id', contactId).maybeSingle()
  const tags = Array.isArray(contact?.tags) ? contact.tags : []
  if (!tags.includes(OFFER_SALE_TAG)) {
    await db.from('contacts').update({ tags: [...tags, OFFER_SALE_TAG] }).eq('id', contactId)
  }
  return { contactId }
}

// Staff notice on a paid purchase — org-configured ops recipients with the
// master-push fallback (sendOpsAlert never throws). Staff-facing copy.
export async function notifyStaffOfPaidPurchase(db, purchase, offer) {
  const { data: loc } = await db
    .from('locations')
    .select('organization_id, name')
    .eq('id', purchase.location_id)
    .maybeSingle()
  if (!loc?.organization_id) return { sent: false }

  const amount = formatEuro(purchase.amount_cents)
  const subject = `NEW SALE: ${offer.name} (${amount}) - ${purchase.buyer_name}`
  const htmlBody = `
    <p><strong>${purchase.buyer_name}</strong> just bought <strong>${offer.name}</strong> (${offer.bonus_headline}) for <strong>${amount}</strong>.</p>
    <ul>
      <li>Email: ${purchase.buyer_email}</li>
      <li>Phone: ${purchase.buyer_phone || 'not given'}</li>
      <li>Studio: ${loc.name || purchase.location_id}</li>
    </ul>
    <p>Set them up in Glofox, then mark the sale fulfilled in Approvals.</p>`
  await sendOpsAlert({
    organizationId: loc.organization_id,
    locationId: purchase.location_id,
    subject,
    htmlBody,
    pushBody: `${purchase.buyer_name} bought ${offer.name} (${amount})`,
  }, { db })
  return { sent: true }
}
