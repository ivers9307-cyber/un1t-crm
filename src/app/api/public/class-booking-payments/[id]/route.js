// GET /api/public/class-booking-payments/[id]
// Public, read-only status of one paid class booking, for the funnel's payment
// step to poll. Returns only display-safe fields (no contact PII). If still
// pending, re-checks the provider so the UI can advance before the webhook lands.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getOrder } from '@/lib/revolut'
import { markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { checkRateLimit } from '@/lib/rate-limit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function GET(_request, props) {
  const { id } = await props.params
  const db = createServerClient()
  const { data, error } = await db.from('class_booking_requests')
    .select('id, status, payment_status, payment_provider, payment_provider_ref, payment_checkout_token, payment_checkout_url, amount_cents, currency, class_name')
    .eq('id', id).maybeSingle()
  if (error || !data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let row = data
  // Cap the live provider re-check per booking so fast polling can't hammer
  // Revolut. Status reads still return the cached DB row when over budget.
  const recheckAllowed = (row.payment_status === 'pending' && row.payment_provider === 'revolut' && row.payment_provider_ref)
    ? (await checkRateLimit(db, `cbpoll:${id}`, { max: 20, windowMs: 5 * 60_000 })).allowed
    : false
  if (recheckAllowed) {
    try {
      const order = await getOrder(row.payment_provider_ref)
      const state = String(order?.state || '').toLowerCase()
      const { released } = await markClassBookingPaymentStatus({ db, request: row, providerState: state, providerAmount: Number.isFinite(order?.amount) ? order.amount : null })
      if (released) {
        try { await publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id: row.id }, deduplicationId: `class-booking-${row.id}` }) } catch { /* queue is the guarantee */ }
      }
      const { data: fresh } = await db.from('class_booking_requests')
        .select('id, status, payment_status, payment_provider, payment_checkout_token, payment_checkout_url, amount_cents, currency, class_name')
        .eq('id', id).maybeSingle()
      if (fresh) row = fresh
    } catch (e) { logWarn('classbook-poll', 're-check failed', { err: e }) }
  }

  const paid = row.payment_status === 'paid'
  return NextResponse.json({ success: true, data: {
    id: row.id,
    paid,
    booking_status: row.status,
    payment_status: row.payment_status,
    checkout: { provider: row.payment_provider, token: row.payment_checkout_token, url: row.payment_checkout_url },
    amount_cents: row.amount_cents, currency: row.currency, class_name: row.class_name,
  } })
}
