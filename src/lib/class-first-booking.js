// CLASSFIRST.1 — book the class a /trial buyer or a /corp claimant picked,
// once the credits are on their account. The purchase or claim row carries
// the class (class_event_id / class_name / class_starts_at, mig 799); after
// the grant (the Glofox plan, the un1t.online settle, the promo grant) the
// caller queues ONE class_booking_requests row for it, marked `funded_by`
// that row, and the process-class-bookings worker books it with everything
// the public funnel already has: the Glofox or un1t.online processor, the
// retries, the staff card on a refusal, the confirmation.
//
// A funded row is different from a funnel row in one way the processors
// read (`funded_by` set): the credits are already there, so no trial is
// ever granted for it and an empty balance is a card (funded_no_balance),
// never the paid-trial reply and never needs_credit_grant.
//
// Best-effort by construction: the grant has landed before this runs, so a
// failed insert is logged at error with ids and returned, never thrown. A
// unique violation (one active row per contact and class) is "already
// queued": a re-run of the grant's side effects queues nothing twice.
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { logError } from '@/lib/log'

export const FUNDED_BY = Object.freeze({ trialPurchase: 'trial_purchase', corpPromo: 'corp_promo' })
export const FUNDED_NO_BALANCE = 'funded_no_balance'
const UNIQUE_VIOLATION = '23505'

/**
 * The queue arguments off a trial_purchases or corp_promo_claims row, or null
 * when the row carries no class (the buyer continued without one).
 * @param {object} row
 * @param {{ fundedBy: 'trial_purchase'|'corp_promo' }} opts
 */
export function fundedBookingFromRow(row, { fundedBy }) {
  if (!row || typeof row !== 'object' || !row.class_event_id || !row.contact_id) return null
  return {
    fundedBy,
    fundedById: row.id,
    locationId: row.location_id,
    contactId: row.contact_id,
    pageId: row.page_id || null,
    eventId: row.class_event_id,
    className: row.class_name || null,
    startsAt: row.class_starts_at || null,
    customer: {
      name: row.customer_name || [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
      email: row.customer_email || null,
      phone: row.customer_phone || null,
    },
    terms: row.terms_accepted_at
      ? { terms_accepted_at: row.terms_accepted_at, terms_source: row.terms_source || null, terms_version: row.terms_version || null }
      : {},
  }
}

/**
 * Queue the booking. Never throws.
 * @returns {Promise<{ queued: true, id: string|null, deduped?: true } | { queued: false, reason: string }>}
 */
export async function queueFundedClassBooking(db, { fundedBy, fundedById, locationId, contactId, pageId = null, eventId, className = null, startsAt = null, customer = {}, terms = {} }) {
  const ids = { fundedBy, fundedById, locationId, contactId, eventId }
  if (!fundedBy || !fundedById || !locationId || !contactId || !eventId) {
    logError('class-first', 'funded booking not queued: incomplete', ids)
    return { queued: false, reason: 'incomplete' }
  }
  let data
  let error
  try {
    ({ data, error } = await db.from('class_booking_requests').insert({
      ...terms,
      ...(pageId ? { page_id: pageId } : {}),
      location_id: locationId,
      contact_id: contactId,
      glofox_event_id: eventId,
      class_name: className,
      starts_at: startsAt,
      customer_name: customer.name || null,
      customer_email: customer.email || null,
      customer_phone: customer.phone || null,
      trial_membership_id: null,
      trial_plan_code: null,
      funded_by: fundedBy,
      funded_by_id: fundedById,
      status: 'queued',
    }).select('id').maybeSingle())
  } catch (e) {
    error = e
  }
  if (error?.code === UNIQUE_VIOLATION) return { queued: true, id: null, deduped: true }
  if (error) {
    logError('class-first', 'funded booking not queued', { ...ids, code: error.code ?? null })
    return { queued: false, reason: error.code || 'insert_failed' }
  }
  const id = data?.id || null
  if (id) {
    // Push delivery (QSTASH.7): a nudge, never the guarantee; the cron drains the row either way.
    try {
      await publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id }, deduplicationId: `class-booking-${id}` })
    } catch { /* publishQueuePush swallows its own errors; belt and braces */ }
  }
  return { queued: true, id }
}
