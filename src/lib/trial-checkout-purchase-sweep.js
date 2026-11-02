// STILL39SEQ.1 — the checkout €39 purchase sweep. Every 2 minutes (an arm of
// the process-trial-purchases cron) it offers each recent paid, granted
// trial_purchases row to the studio's active 'paid_trial_checkout_purchased'
// sequences.
//
// trial_purchases is the CRM's own /trial checkout: Stillorgan buyers pay
// there (Revolut, then the Glofox plan grant). Hatch Street buyers are sent to
// un1t.online's hosted checkout and greeted by the un1t_paid_trial_purchased
// sweep (src/lib/un1t-paid-trial-purchases.js), which also sees purchases made
// straight on un1t.online, so a Hatch sequence uses that trigger instead.
//
// Why a sweep and not a pipeline trigger: a buyer is placed straight onto the
// €39 board's New Leads (a create, or a move from Acquisition that only the
// nightly pass may make), so a stage trigger cannot greet them on time.
//
// No queue column: enrolment is once per person per sequence (a unique index
// on sequence_enrollments, enrolContacts' ON CONFLICT DO NOTHING), so
// re-offering the same purchase every tick is harmless, and a refused offer is
// simply retried on the next tick while the grant is inside the window.
// Switching a sequence on later greets only buyers of the last 48 hours.
// A purchase counts once it is GRANTED: before that the buyer has no trial to
// book with (a failed grant is staff's card, not a greeting).

import { triggerSequencesForCheckoutTrialPurchased } from '@/lib/sequences/triggers'
import { logError } from '@/lib/log'

const MODULE = 'trial-checkout-purchase-sweep'
export const CHECKOUT_PURCHASE_TRIGGER = 'paid_trial_checkout_purchased'
/** How far back a grant is still offered (48 hours: many retries, no backlog). */
export const CHECKOUT_PURCHASE_WINDOW_MS = 48 * 3_600_000
/** One page holds every grant of the window by a wide margin (four in the first ten days). */
const PAGE = 1000

/**
 * @param {object} db service-role client
 * @param {{ nowMs?: number, trigger?: Function }} [opts]
 * @returns {Promise<{ ok: boolean, locations: number, checked: number, enrolled: number, already: number, failed: number }>}
 */
export async function sweepCheckoutTrialPurchases(db, { nowMs = Date.now(), trigger = triggerSequencesForCheckoutTrialPurchased } = {}) {
  const out = { ok: true, locations: 0, checked: 0, enrolled: 0, already: 0, failed: 0 }

  const { data: sequences, error: seqErr } = await db
    .from('email_sequences')
    .select('location_id')
    .eq('trigger_type', CHECKOUT_PURCHASE_TRIGGER)
    .eq('status', 'active')
  if (seqErr) {
    logError(MODULE, 'sequence lookup failed', { code: seqErr.code ?? null })
    out.ok = false
    return out
  }
  const locationIds = [...new Set((sequences || []).map((s) => s?.location_id).filter(Boolean))]
  out.locations = locationIds.length
  if (locationIds.length === 0) return out

  const { data: rows, error: tpErr } = await db
    .from('trial_purchases')
    .select('id, location_id, contact_id, amount_cents, granted_at')
    .in('location_id', locationIds)
    .eq('payment_status', 'paid')
    .eq('status', 'granted')
    .gt('amount_cents', 0)
    .not('contact_id', 'is', null)
    .gte('granted_at', new Date(nowMs - CHECKOUT_PURCHASE_WINDOW_MS).toISOString())
    .order('granted_at', { ascending: false })
    .order('id', { ascending: true })
    .range(0, PAGE - 1)
  if (tpErr) {
    logError(MODULE, 'purchase read failed', { code: tpErr.code ?? null })
    out.ok = false
    return out
  }

  // One offer per buyer per studio: their newest grant (chosen here, not by
  // trusting the read's order).
  const allowed = new Set(locationIds)
  const newest = new Map()
  for (const t of rows || []) {
    if (!t?.contact_id || !allowed.has(t.location_id) || !(Number(t.amount_cents) > 0)) continue
    const key = `${t.location_id}:${t.contact_id}`
    const prev = newest.get(key)
    if (!prev || Date.parse(t.granted_at) > Date.parse(prev.granted_at)) newest.set(key, t)
  }
  for (const t of newest.values()) {
    out.checked++
    let res
    try {
      res = await trigger(db, { contactId: t.contact_id, locationId: t.location_id, purchaseId: t.id })
    } catch (e) {
      logError(MODULE, 'trigger threw', { locationId: t.location_id, errName: e?.name ?? null })
      res = null
    }
    if (!res?.ok) {
      out.failed++
      out.ok = false
    } else if ((res.enrolled || 0) > 0) {
      out.enrolled += res.enrolled
    } else {
      out.already++
    }
  }
  return out
}
