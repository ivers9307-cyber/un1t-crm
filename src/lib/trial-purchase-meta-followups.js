// TRIALFOLLOWUP.1 — the two events after a paid trial's Purchase that tell
// Meta which buyers were worth having:
//
//   Schedule   the buyer's first Glofox class booking after the grant
//              (BOOKING_CREATED, status BOOKED; a waitlist place is not a
//              booking). Once per purchase.
//   Subscribe  the buyer takes a membership that is NOT the trial plan
//              (MEMBERSHIP_CREATED, status ACTIVE), with the membership's
//              price as the value. Once per purchase.
//
// Both hang off the Glofox webhook, both are best-effort (a failure is a
// warn line, never a failed webhook), and both claim their once-per-purchase
// stamp on the row BEFORE sending (a CAS on attribution.meta_*_sent_at), so
// two deliveries of the same webhook cannot send twice; a failed send
// releases the stamp so the next booking or membership tries again. The
// Purchase and these two share the purchase's contact id as external_id, so
// Meta joins them to one person; the event ids are derived from the
// purchase id, so a replay inside Meta's dedupe window is one event.
//
// Why only paid trials: the free funnel already sends Schedule on its own
// booking path; a Subscribe for every member would need the membership
// value model the estate does not have yet. Richard's call, 22 Oct 2026.

import { sendWebsiteConversion } from '@/lib/meta-capi'
import { logWarn } from '@/lib/log'

export const SCHEDULE_WINDOW_DAYS = 30
export const SUBSCRIBE_WINDOW_DAYS = 60

const PURCHASE_COLS = 'id, location_id, contact_id, customer_email, customer_phone, first_name, last_name, membership_id, plan_code, product_name, currency, granted_at, attribution'

/** The most recent granted paid trial for this contact at this studio inside the window, else null. */
export async function findRecentGrantedTrialPurchase(db, { contactId, locationId, withinDays, now = Date.now() }) {
  if (!contactId || !locationId) return null
  const since = new Date(now - withinDays * 86400_000).toISOString()
  const { data, error } = await db
    .from('trial_purchases')
    .select(PURCHASE_COLS)
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .eq('status', 'granted')
    .gte('granted_at', since)
    .order('granted_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`trial_purchases read failed: ${error.message}`)
  return data?.[0] || null
}

/** Claim the once-per-purchase stamp; false when another delivery already holds it. */
async function claimStamp(db, purchase, key, at) {
  const attribution = { ...(purchase.attribution && typeof purchase.attribution === 'object' ? purchase.attribution : {}), [key]: at }
  const { data, error } = await db
    .from('trial_purchases')
    .update({ attribution })
    .eq('id', purchase.id)
    .is(`attribution->>${key}`, null)
    .select('id')
  if (error) throw new Error(`stamp write failed: ${error.message}`)
  return (data || []).length > 0
}

/** Release a stamp after a send that did not land, so a later event retries. */
async function releaseStamp(db, purchase, key) {
  const attribution = { ...(purchase.attribution && typeof purchase.attribution === 'object' ? purchase.attribution : {}) }
  delete attribution[key]
  const { error } = await db.from('trial_purchases').update({ attribution }).eq('id', purchase.id).select('id')
  if (error) logWarn('trial-followup', 'stamp release failed', { purchaseId: purchase.id, key, err: error.message })
}

function identity(purchase) {
  return {
    locationId: purchase.location_id,
    email: purchase.customer_email, phone: purchase.customer_phone,
    firstName: purchase.first_name, lastName: purchase.last_name,
    externalId: purchase.contact_id,
    eventSourceUrl: purchase.attribution?.event_source_url || undefined,
    fbc: purchase.attribution?.fbc, fbp: purchase.attribution?.fbp,
  }
}

async function sendOnce(db, { purchase, key, event, now }) {
  const at = new Date(now).toISOString()
  const claimed = await claimStamp(db, purchase, key, at)
  if (!claimed) return { sent: false, reason: 'already_sent' }
  const res = await sendWebsiteConversion(db, { ...identity(purchase), ...event })
  if (!res?.sent) {
    await releaseStamp(db, purchase, key)
    return { sent: false, reason: res?.reason || 'not_sent' }
  }
  return { sent: true, purchaseId: purchase.id }
}

/**
 * BOOKING_CREATED for a contact: a Schedule for their paid trial, once.
 * `booking` is the webhook's Payload object. Never throws.
 */
export async function sendTrialScheduleFollowup(db, { contactId, locationId, booking, now = Date.now() }) {
  try {
    const status = String(booking?.status || '').toUpperCase()
    if (status !== 'BOOKED') return { sent: false, reason: 'not_booked' }
    const purchase = await findRecentGrantedTrialPurchase(db, { contactId, locationId, withinDays: SCHEDULE_WINDOW_DAYS, now })
    if (!purchase) return { sent: false, reason: 'no_trial_purchase' }
    return await sendOnce(db, {
      purchase, key: 'meta_schedule_sent_at', now,
      event: { eventName: 'Schedule', eventId: `trialschedule-${purchase.id}`, contentName: purchase.product_name || 'Class' },
    })
  } catch (e) {
    logWarn('trial-followup', 'schedule follow-up threw', { contactId, err: e?.message })
    return { sent: false, reason: 'exception' }
  }
}

/**
 * MEMBERSHIP_CREATED for a contact: a Subscribe for their paid trial, once,
 * unless the membership IS the trial plan. `membership` is the webhook's
 * Payload object: { id, status, price, membership_definition: { id, name } }.
 * Glofox's membership price is in the branch currency's major unit (the
 * MEMBERSHIP_CREATED feed shows 99 for a €99 plan; invoices are in cents).
 * Never throws.
 */
export async function sendTrialSubscribeFollowup(db, { contactId, locationId, membership, now = Date.now() }) {
  try {
    const status = String(membership?.status || '').toUpperCase()
    if (status && status !== 'ACTIVE') return { sent: false, reason: 'not_active' }
    const purchase = await findRecentGrantedTrialPurchase(db, { contactId, locationId, withinDays: SUBSCRIBE_WINDOW_DAYS, now })
    if (!purchase) return { sent: false, reason: 'no_trial_purchase' }
    const defId = String(membership?.membership_definition?.id || '')
    if (defId && defId === String(purchase.membership_id)) return { sent: false, reason: 'trial_plan_itself' }
    const price = Number(membership?.price)
    const value = Number.isFinite(price) && price >= 0 ? price : undefined
    return await sendOnce(db, {
      purchase, key: 'meta_subscribe_sent_at', now,
      event: {
        eventName: 'Subscribe', eventId: `trialsubscribe-${purchase.id}`,
        contentName: membership?.membership_definition?.name || 'Membership', contentType: 'product',
        value, currency: purchase.currency || 'EUR',
        orderId: membership?.id ? String(membership.id) : undefined,
      },
    })
  } catch (e) {
    logWarn('trial-followup', 'subscribe follow-up threw', { contactId, err: e?.message })
    return { sent: false, reason: 'exception' }
  }
}
