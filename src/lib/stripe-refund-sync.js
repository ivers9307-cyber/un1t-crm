// charge.refunded → race_payments patch (HOST-PORTAL.7). Stripe's
// charge.amount_refunded is the CUMULATIVE total, so writing it absolutely is
// idempotent under re-delivery and monotonic under out-of-order events.
// Mirrors /api/orders/[id]/refund semantics: partial stays 'completed',
// full → 'refunded'. Returns null when nothing needs writing.
export function refundPatchFromCharge(charge, payment, nowIso) {
  const refunded = Number(charge?.amount_refunded) || 0
  const current = Number(payment?.refunded_amount_cents) || 0
  if (refunded <= current) return null
  return {
    refunded_amount_cents: refunded,
    refunded_at: payment?.refunded_at || nowIso,
    status: refunded >= (Number(payment?.amount_cents) || 0) ? 'refunded' : 'completed',
  }
}
