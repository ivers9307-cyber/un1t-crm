// POST /api/public/events/[slug]/raffle — RAFFLE.3: buy raffle tickets online
// from the public event page.
//
// Body: { quantity, name, email }. The event comes from the slug (published +
// active only); the raffle must have online sales on and not past its closing
// time. The price is the server's (priceForQuantity: an option for exactly
// that many tickets, else the one-ticket price), never a client value. Inserts
// an `awaiting_payment` raffle_orders row and opens the Revolut order. NO
// contact is created or linked, now or when the payment lands. No auth;
// rate-limited per event slug and IP.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { eventIsPublic } from '@/lib/host-events'
import { priceForQuantity } from '@/lib/raffle-format'
import {
  loadRaffleForEvent, onlineSalesState, createRaffleOrderPayment,
  RAFFLE_ORDER_COLS, ONLINE_MAX_TICKETS,
} from '@/lib/raffle-online'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  quantity: z.number().int().min(1).max(ONLINE_MAX_TICKETS),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
})

const fail = (status, code, error) => NextResponse.json({ success: false, code, error }, { status })

export async function POST(request, props) {
  const params = await props.params
  const slug = params.slug
  const db = createServerClient()

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `raffle-buy:${slug}:${ip}`, { max: 10, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many attempts. Please wait a few minutes and try again.')

  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, slug, name, kind, location_id, active, status, host_id,
      host:event_hosts!host_id ( id, payment_provider )
    `)
    .eq('slug', slug)
    .eq('active', true)
    .eq('status', 'published')
    .single()
  if (raceErr || !race || !eventIsPublic(race)) return fail(404, 'not_found', 'Event not found')
  // The raffle checkout is UN1T's own Revolut merchant: a third-party host's
  // event never sells raffle tickets online (the same rule as buildPublicRaffle
  // and the settings route), whatever its raffle row says.
  if (race.host_id || race.host) return fail(400, 'not_enabled', 'Raffle tickets are not on sale online for this event.')

  let raffle
  try {
    raffle = await loadRaffleForEvent(db, race)
  } catch (e) {
    logError('raffle-buy', 'raffle read failed', { err: e, raceId: race.id })
    return fail(500, 'unavailable', 'Could not start your order. Please try again.')
  }
  const state = onlineSalesState(raffle)
  if (!state.open) {
    return fail(400, state.reason === 'closed' ? 'closed' : 'not_enabled',
      state.reason === 'closed' ? 'Online raffle sales have closed.' : 'Raffle tickets are not on sale online for this event.')
  }

  const price = priceForQuantity(raffle, b.quantity)
  const { data: order, error: insErr } = await db.from('raffle_orders').insert({
    raffle_id: raffle.id,
    race_event_id: race.id,
    location_id: race.location_id,
    buyer_name: b.name,
    buyer_email: b.email.toLowerCase(),
    quantity: b.quantity,
    amount_cents: price.cents,
    currency: raffle.currency || 'EUR',
    option_label: price.label,
    status: 'awaiting_payment',
  }).select(RAFFLE_ORDER_COLS).single()
  if (insErr || !order) {
    logError('raffle-buy', 'order insert failed', { err: insErr, raceId: race.id })
    return fail(500, 'unavailable', 'Could not start your order. Please try again.')
  }

  let payment
  try {
    const returnUrl = `${await resolveCustomerBaseUrl(db, race.location_id)}/event/${slug}?raffle_order=${order.id}`
    payment = await createRaffleOrderPayment({ db, order, race, host: race.host || null, returnUrl })
  } catch (err) {
    const unavailable = err?.code === 'payments_unavailable'
    if (!unavailable) logError('raffle-buy', 'payment create failed', { err, orderId: order.id })
    // No checkout was handed out: the row must never linger as unconfirmed.
    const { error: failErr } = await db.from('raffle_orders').update({ status: 'failed' }).eq('id', order.id)
    if (failErr) logWarn('raffle-buy', 'could not mark order failed', { err: failErr, orderId: order.id })
    if (unavailable) return fail(400, 'payments_unavailable', 'Raffle tickets are not on sale online for this event.')
    return fail(502, 'checkout_failed', 'Could not start checkout. Please try again.')
  }

  return NextResponse.json({
    success: true,
    data: { order: { id: order.id, amount_cents: order.amount_cents, currency: order.currency, quantity: order.quantity, checkout: payment.checkout } },
  })
}
