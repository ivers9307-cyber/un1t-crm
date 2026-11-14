// TRIALABANDON.1 — the leaf the abandoned-checkout follow-up shares between
// its sweep (src/lib/trial-checkout-abandoned.js) and the sequence step
// senders (src/lib/sequences/steps.js): what counts as a purchase, the resume
// link the copy can use, the exit that stops the sequence once someone pays,
// and the pre-send check. It imports nothing from the sequence engine, so the
// senders can use it without a cycle (the sweep reaches the engine through
// triggers.js).
import { logWarn, logError } from '@/lib/log'
import { TRIAL_CHECKOUT_REUSE_MS } from '@/lib/trial-checkout-window'

const MODULE = 'trial-abandoned'

/** The sequence trigger type, and the source_type of every enrolment it makes. */
export const ABANDONED_TRIGGER = 'paid_trial_checkout_abandoned'
/** sequence_enrollments.exit_reason of an enrolment ended because they paid. */
export const PURCHASED_EXIT_REASON = 'trial_purchased'
/** utm_campaign on the resume link. */
export const RESUME_UTM_CAMPAIGN = 'trial-abandoned'

// A trial_purchases row someone paid for: the money is in (payment_status
// 'paid', which a needs_review row keeps), or the row is on its way to, or
// has, the grant.
const PURCHASE_STATUSES = new Set(['queued', 'processing', 'granted'])
/** The same rule as a PostgREST or-filter (the pre-send check's one read). */
export const PURCHASE_ROW_FILTER = 'payment_status.eq.paid,status.in.(queued,processing,granted)'

export function isPurchaseRow(row) {
  return Boolean(row) && (row.payment_status === 'paid' || PURCHASE_STATUSES.has(row.status))
}

/** The checkout an enrolment was made for (enrolment metadata), or null. */
export function trialCheckoutFromEnrollment(enrollment) {
  const c = enrollment?.metadata?.trial_checkout
  return c && typeof c === 'object' && !Array.isArray(c) ? c : null
}

/**
 * The link back to the /trial page for one enrolment, built at send time.
 * `/trial?studio=<key>&purchase=<id>` while the row was an open Revolut
 * checkout at enrolment AND is still young enough to be handed back
 * (TRIAL_CHECKOUT_REUSE_MS); otherwise `/trial?studio=<key>` (a Hatch Street
 * checkout URL is never stored, and a closed order cannot be reopened). The
 * studio is left off when the row's page is not one of the /trial studios.
 * Pure. Both values are '' for an enrolment that carries no checkout, so a
 * body that uses the tag on another trigger renders nothing.
 *
 * @param {{ baseUrl: string, checkout: object|null, medium: 'email'|'whatsapp', nowMs?: number }} args
 * @returns {{ url: string, suffix: string }} `suffix` is the query string
 *   alone (no '?'), for a WhatsApp button whose approved link is
 *   `https://<site>/trial?{{1}}`.
 */
export function trialResumeLink({ baseUrl, checkout, medium, nowMs = Date.now() }) {
  if (!checkout || !baseUrl) return { url: '', suffix: '' }
  const params = new URLSearchParams()
  if (typeof checkout.studio === 'string' && /^[a-z0-9-]{1,40}$/.test(checkout.studio)) params.set('studio', checkout.studio)
  const created = Date.parse(checkout.created_at || '')
  const age = Number.isFinite(created) ? nowMs - created : null
  const purchaseId = typeof checkout.purchase_id === 'string' && /^[0-9a-f-]{36}$/i.test(checkout.purchase_id) ? checkout.purchase_id : null
  if (checkout.resumable === true && checkout.provider === 'revolut' && purchaseId && age !== null && age >= 0 && age < TRIAL_CHECKOUT_REUSE_MS) {
    params.set('purchase', purchaseId)
  }
  params.set('utm_source', 'crm')
  params.set('utm_medium', medium === 'whatsapp' ? 'whatsapp' : 'email')
  params.set('utm_campaign', RESUME_UTM_CAMPAIGN)
  const suffix = params.toString()
  return { url: `${String(baseUrl).replace(/\/+$/, '')}/trial?${suffix}`, suffix }
}

/**
 * End one enrolment because the person bought the trial. Compare-and-set on
 * the status, so a run the scheduler finished a moment ago is left alone.
 * @returns {Promise<{ ok: boolean, exited: boolean }>} never throws
 */
export async function exitEnrolmentForPurchase(db, enrollmentId, nowMs = Date.now()) {
  try {
    const { data, error } = await db
      .from('sequence_enrollments')
      .update({ status: 'exited', exit_reason: PURCHASED_EXIT_REASON, next_step_at: null, last_processed_at: new Date(nowMs).toISOString() })
      .eq('id', enrollmentId)
      .in('status', ['active', 'paused'])
      .select('id')
    if (error) {
      logError(MODULE, 'enrolment not exited after a purchase', { enrollmentId, code: error.code ?? null })
      return { ok: false, exited: false }
    }
    return { ok: true, exited: Array.isArray(data) && data.length > 0 }
  } catch (e) {
    logError(MODULE, 'enrolment exit threw', { enrollmentId, errName: e?.name ?? null })
    return { ok: false, exited: false }
  }
}

const PROCEED = Object.freeze({ proceed: true })

/**
 * Immediately before a step of an abandoned-checkout enrolment is sent: has
 * this person paid for a trial at the sequence's studio since that checkout?
 * The sweep's exit pass is the main stop (every 2 minutes); this closes the
 * gap between a payment and the next pass.
 *
 * It only ever ADDS a stop, and it fails OPEN, like the dunning pre-send
 * check: an enrolment of another trigger, a read that failed, or an exit that
 * could not be written all proceed (and the last two are logged), so a blip
 * never silences the sequence or leaves a run that skips one step and sends
 * the next.
 *
 * @returns {Promise<{ proceed: true } | { proceed: false, reason: string }>} never throws
 */
export async function trialAbandonPresendGate(db, { enrollment, contact, sequence } = {}) {
  try {
    if (String(enrollment?.source_type || '') !== ABANDONED_TRIGGER) return PROCEED
    const locationId = sequence?.location_id
    const contactId = contact?.id
    if (!locationId || !contactId) return PROCEED
    let q = db
      .from('trial_purchases')
      .select('id')
      .eq('location_id', locationId)
      .eq('contact_id', contactId)
      .or(PURCHASE_ROW_FILTER)
    const since = trialCheckoutFromEnrollment(enrollment)?.created_at
    if (typeof since === 'string' && Number.isFinite(Date.parse(since))) q = q.gte('created_at', since)
    const { data, error } = await q.limit(1)
    if (error) {
      logWarn(MODULE, 'pre-send purchase check failed, sending anyway', { contactId, locationId, code: error.code ?? null })
      return PROCEED
    }
    if (!Array.isArray(data) || data.length === 0) return PROCEED
    const res = await exitEnrolmentForPurchase(db, enrollment.id)
    if (!res.ok) return PROCEED
    return { proceed: false, reason: 'bought the trial since the checkout' }
  } catch (e) {
    logWarn(MODULE, 'pre-send purchase check threw, sending anyway', { contactId: contact?.id ?? null, errName: e?.name ?? null })
    return PROCEED
  }
}
