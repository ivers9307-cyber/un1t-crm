// OFFERTRACK.1 — Meta events for /offers sales, the way /trial sends them.
//
// The checkout sends Lead and InitiateCheckout (server and browser, the same
// event ids, so Meta counts one of each). The Purchase is sent once, at the
// moment a purchase row turns paid: the Revolut webhook, the public status
// poll and the reconcile cron (each only when their compare-and-set moved the
// row), and the un1t.online sweep when it settles a page row. A sale made
// outside the page (origin 'off_page') came from no ad and sends nothing.
//
// The buyer's IP address and user agent ride on offer_purchases.attribution
// only until the Purchase is tried (the same rule as trial_purchases): this
// module removes them right after, and no public route returns `attribution`.
import { sendWebsiteConversion } from '@/lib/meta-capi'
import { withoutClientData } from '@/lib/trial-purchase-conversion'
import { logWarn } from '@/lib/log'

const LOG = 'offers'

/** The event ids a browser and the server share for one checkout. */
export const offerLeadEventId = (leadEventId, purchaseId) => leadEventId || `offerlead-${purchaseId}`
export const offerCheckoutEventId = (leadEventId) => `offercheckout-${leadEventId}`
export const offerPurchaseEventId = (purchaseId) => `offerpurchase-${purchaseId}`

const splitName = (name) => {
  const parts = String(name || '').trim().split(/\s+/)
  return { firstName: parts[0] || undefined, lastName: parts.slice(1).join(' ') || undefined }
}

/** The shared identity fields for one buyer at the checkout or from a row. */
function identity({ locationId, buyer, attribution, contactId, contentName }) {
  const a = attribution && typeof attribution === 'object' ? attribution : {}
  return {
    locationId,
    email: buyer.email, phone: buyer.phone,
    ...splitName(buyer.name),
    externalId: contactId || undefined,
    eventSourceUrl: a.event_source_url || undefined,
    contentName,
    fbc: a.fbc, fbp: a.fbp,
    clientIp: a.client_ip, userAgent: a.client_user_agent,
  }
}

/**
 * Lead + InitiateCheckout at the checkout. Best-effort: never throws.
 * @param {import('@/lib/supabase').Db} db
 */
export async function sendOfferCheckoutConversions(db, { offer, buyer, attribution, purchaseId, contactId = null }, { send = sendWebsiteConversion } = {}) {
  const leadId = offerLeadEventId(attribution?.lead_event_id, purchaseId)
  const base = identity({ locationId: offer.location_id, buyer, attribution, contactId, contentName: offer.name })
  try {
    await send(db, { ...base, eventName: 'Lead', eventId: leadId })
  } catch (err) { logWarn(LOG, 'capi offer lead failed', { purchaseId, err }) }
  try {
    await send(db, {
      ...base, eventName: 'InitiateCheckout', eventId: offerCheckoutEventId(leadId),
      value: (offer.price_cents || 0) / 100, currency: offer.currency || 'EUR', contentType: 'product',
    })
  } catch (err) { logWarn(LOG, 'capi offer initiate checkout failed', { purchaseId, err }) }
}

const ROW_COLS = 'id, location_id, contact_id, buyer_name, buyer_email, buyer_phone, amount_cents, currency, origin, state, attribution, offer:sale_offers ( name )'

/**
 * The Purchase for one paid row, then the buyer's browser details off it.
 * Call only where the row has just turned paid. Best-effort: never throws.
 * @param {import('@/lib/supabase').Db} db
 * @param {string} purchaseId
 */
export async function sendOfferPurchaseConversion(db, purchaseId, { send = sendWebsiteConversion } = {}) {
  try {
    const { data: row, error } = await db.from('offer_purchases').select(ROW_COLS).eq('id', purchaseId).maybeSingle()
    if (error || !row) {
      logWarn(LOG, 'offer purchase unreadable for its Purchase event', { purchaseId, err: error })
      return { sent: false, reason: 'unreadable' }
    }
    if (row.state !== 'paid' || row.origin !== 'page') return { sent: false, reason: 'not_a_page_sale' }
    let result
    try {
      result = await send(db, {
        ...identity({
          locationId: row.location_id,
          buyer: { name: row.buyer_name, email: row.buyer_email, phone: row.buyer_phone },
          attribution: row.attribution, contactId: row.contact_id, contentName: row.offer?.name,
        }),
        eventName: 'Purchase',
        eventId: offerPurchaseEventId(row.id),
        value: (row.amount_cents || 0) / 100, currency: row.currency || 'EUR',
        orderId: row.id, contentType: 'product',
      })
    } catch (err) {
      logWarn(LOG, 'capi offer purchase failed', { purchaseId, err })
      result = { sent: false, reason: 'threw' }
    }
    const stripped = withoutClientData(row.attribution)
    if (stripped) {
      const { error: stripErr } = await db.from('offer_purchases').update({ attribution: stripped }).eq('id', row.id)
      if (stripErr) logWarn(LOG, 'offer buyer browser details not removed', { purchaseId, err: stripErr })
    }
    return result
  } catch (err) {
    logWarn(LOG, 'offer purchase event failed', { purchaseId, err })
    return { sent: false, reason: 'threw' }
  }
}
