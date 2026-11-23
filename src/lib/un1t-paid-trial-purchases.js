// PAIDTRIALTRIGGER.1 — the €39 purchase sweep. Every 15 minutes (an arm of
// the un1t-online-sync cron, like the welcome sweep) it offers each recent
// paid-trial purchase at a un1t.online studio to the studio's active
// 'un1t_paid_trial_purchased' sequences.
//
// Why a sweep and not a pipeline trigger: a buyer is usually CREATED straight
// onto the €39 board's New Leads, and a create is not a move, so a
// pipeline_stage_change sequence could never greet them (TDSEQ.1).
//
// No queue column: enrolment is once per person per sequence (a unique index on
// sequence_enrollments, enrolContacts' ON CONFLICT DO NOTHING), so re-offering
// the same purchase every tick is harmless, and a refused offer is simply
// retried on the next tick while the purchase is inside PURCHASE_WINDOW_MS.
// Switching a sequence on later greets only buyers of the last 48 hours.
//
// A purchase is judged by the amount PAID (PAIDTRIALAMOUNT.1): a €0
// transaction on the paid-trial product is the free trial it used to be,
// never a purchase. The product set is paidTrialProductIdsFor's, which throws
// on a failed read: "could not read" must never become "no purchases".

import { paidTrialProductIdsFor } from '@/lib/paid-trial-products'
import { triggerSequencesForUn1tPaidTrialPurchased } from '@/lib/sequences/triggers'
import { logError } from '@/lib/log'

const MODULE = 'un1t-paid-trial-purchases'
/** How far back a purchase is still offered (48 hours: many retries, no backlog). */
export const PURCHASE_WINDOW_MS = 48 * 3_600_000
/** One page holds every purchase of the window by a wide margin (five in the first week). */
const PAGE = 1000

function emptyCounts() {
  return { ok: true, skipped_no_sequence: false, checked: 0, enrolled: 0, already: 0, failed: 0 }
}

/**
 * @param {object} db service-role client
 * @param {string} locationId a un1t.online studio
 * @param {{ nowMs?: number, trigger?: Function }} [opts]
 * @returns {Promise<{ ok: boolean, skipped_no_sequence: boolean, checked: number, enrolled: number, already: number, failed: number }>}
 */
export async function sweepPaidTrialPurchases(db, locationId, { nowMs = Date.now(), trigger = triggerSequencesForUn1tPaidTrialPurchased } = {}) {
  const out = emptyCounts()

  const { count, error: seqErr } = await db
    .from('email_sequences')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('trigger_type', 'un1t_paid_trial_purchased')
    .eq('status', 'active')
  if (seqErr) {
    logError(MODULE, 'sequence lookup failed', { locationId, code: seqErr.code ?? null })
    out.ok = false
    return out
  }
  if (!count) {
    out.skipped_no_sequence = true
    return out
  }

  let productIds
  try {
    productIds = await paidTrialProductIdsFor(db, locationId)
  } catch (e) {
    logError(MODULE, 'paid-trial products unreadable', { locationId, errName: e?.name ?? null })
    out.ok = false
    return out
  }
  if (!productIds || productIds.size === 0) return out

  const { data: rows, error: txErr } = await db
    .from('un1t_transactions')
    .select('id, contact_id, product_id, amount_cents, remote_created_at')
    .eq('location_id', locationId)
    .in('product_id', [...productIds])
    .gt('amount_cents', 0)
    .eq('refunded', false)
    .not('contact_id', 'is', null)
    .gte('remote_created_at', new Date(nowMs - PURCHASE_WINDOW_MS).toISOString())
    .order('remote_created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(0, PAGE - 1)
  if (txErr) {
    logError(MODULE, 'purchase read failed', { locationId, code: txErr.code ?? null })
    out.ok = false
    return out
  }

  // One offer per buyer: their newest purchase (chosen here, not by trusting
  // the read's order).
  const newestByContact = new Map()
  for (const t of rows || []) {
    if (!t?.contact_id || !(Number(t.amount_cents) > 0)) continue
    const prev = newestByContact.get(t.contact_id)
    if (!prev || Date.parse(t.remote_created_at) > Date.parse(prev.remote_created_at)) newestByContact.set(t.contact_id, t)
  }
  for (const t of newestByContact.values()) {
    out.checked++
    const res = await trigger(db, { contactId: t.contact_id, locationId, transactionId: t.id })
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
