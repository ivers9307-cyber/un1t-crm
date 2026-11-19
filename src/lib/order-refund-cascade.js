// REFUNDCONFIRM.1 — what a recorded refund does to the order's source row,
// in ONE place: the refund route (when the provider answers) and the Revolut
// refund check in the reconcile cron (when it confirms a refund the route
// never heard back about) both call it, so the two can never disagree.
//
//   race_registration  race_payments follows the order's refunded total
//   donation           a FULL refund marks the donation refunded (it leaves
//                      the event's total)
//   car_deposit        a FULL refund marks the deposit refunded
//   anything else      nothing: a refunded trial, offer, class booking,
//                      payment link or fee changes nothing it bought
//
// Every write is best-effort: the money has already gone back and the order
// already says so, so a failed write is logged to be put right by hand and
// never thrown. Each write is idempotent, so running it twice is harmless.
import { logError } from '@/lib/log'
import { markDonationRefunded } from '@/lib/donation-payments'

const LOG = 'orders-refund'

/**
 * @param {object} db  service-role client
 * @param {{ id: string, source_type: string, source_id: string }} order
 * @param {{ isFull: boolean, refundedTotal: number, actorId?: string|null, nowIso?: string }} args
 * @returns {Promise<{ sourceKind: string|null }>}  race_payments.kind, for the
 *   route's tag rules (a refunded price difference skips them)
 */
export async function applyRefundToSource(db, order, { isFull, refundedTotal, actorId = null, nowIso = new Date().toISOString() }) {
  let sourceKind = null
  if (order.source_type === 'race_registration') {
    const { data, error } = await db.from('race_payments')
      .update({ status: isFull ? 'refunded' : 'completed', refunded_at: nowIso, refunded_amount_cents: refundedTotal })
      .eq('id', order.source_id)
      .select('kind')
    if (error) logError(LOG, 'refund issued but race_payments was NOT updated', { err: error, orderId: order.id, paymentId: order.source_id })
    else sourceKind = data?.[0]?.kind || null
  } else if (order.source_type === 'donation' && isFull) {
    try {
      await markDonationRefunded({ db, donationId: order.source_id, byProfileId: actorId })
    } catch (err) {
      logError(LOG, 'refund issued but the donation was NOT marked refunded', { err, orderId: order.id, donationId: order.source_id })
    }
  } else if (order.source_type === 'car_deposit' && isFull) {
    const { error } = await db.from('cars').update({ deposit_status: 'refunded' }).eq('id', order.source_id)
    if (error) logError(LOG, 'refund issued but cars.deposit_status was NOT updated', { err: error, orderId: order.id, carId: order.source_id })
  }
  return { sourceKind }
}
