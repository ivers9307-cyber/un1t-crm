// POST /api/webhooks/revolut/race-payments
//
// SEPARATE Revolut webhook receiver for race payments. Configure
// this URL as a SECOND webhook endpoint in the Revolut Business
// dashboard (or filter the existing one by metadata).
//
// Why separate from /api/webhooks/revolut (cars)?
//   1. Different domain (UN1T vs CCF Autos) — having distinct URLs
//      makes per-business observability + signing-key rotation
//      possible without entangling the two flows.
//   2. The existing handler does cars-only work (deposit_status
//      mutations, deposit-receipt SMS). Forcing it to dispatch on
//      payload.metadata.domain would couple two unrelated business
//      lifecycles in one route.
//
// Operationally: both URLs are valid and Revolut will deliver the
// event to whichever webhook subscribed to it. The order's metadata
// (domain 'un1t_race', or 'un1t_race_gap' for a price difference) is
// NOT checked here: the guard is the lookup itself, since an order id
// with no race_payments row returns 200/skipped and mutates nothing.
//
// Auth: each Revolut webhook gets its OWN signing secret. We try
// REVOLUT_RACE_WEBHOOK_SECRET first (the dedicated one for this
// webhook), falling back to REVOLUT_WEBHOOK_SECRET for the
// transition window or single-merchant-account setups. Both are
// passed to verifyWebhookSignature; whichever matches the header
// candidate wins.
//
// REVPAY.1 — resolve FIRST, claim second. Every Revolut webhook endpoint
// receives every event for every order on the merchant account, so most
// deliveries here are for another flow's order: those now answer 200
// skipped without a dedupe row or a log line. Once the order is ours the
// (event, order) key is claimed, and every path that DEFERS after the claim
// (getOrder throws, the status write fails) releases it and answers
// 200 { deferred }, so an ops resend from the Revolut dashboard is processed
// instead of being answered 'deduped' (the donations route's pattern). After a
// mark that landed, nothing releases the claim: the confirmations and the
// Glofox push are best-effort and must never run twice.

import { NextResponse, after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { sendRaceConfirmations, sendGapPaidEmail } from '@/lib/race-confirmations'
import { recordWebhookEvent, releaseWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { GAP_PAYMENT_KIND } from '@/lib/registration-entry'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  // Race webhook secret, with the cars/shared one as a fallback so
  // pre-split deployments still verify.
  const secrets = [
    process.env.REVOLUT_RACE_WEBHOOK_SECRET,
    process.env.REVOLUT_WEBHOOK_SECRET,
  ].filter(Boolean)
  if (!verifyWebhookSignature(rawBody, sig, ts, { secrets })) {
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  let payload = null
  try { payload = JSON.parse(rawBody) } catch {
    // Empty body during a verification ping — return 200.
    return NextResponse.json({ success: true })
  }

  const orderId = payload?.order_id
  const event = payload?.event
  if (!orderId || !event) return NextResponse.json({ success: true })

  const db = createServerClient()
  const eventId = `${event}:${orderId}`

  // Resolve before claiming (see the header): an order that is not ours takes
  // no dedupe row. A failed read is not "not ours": defer (nothing claimed yet).
  let payment
  try {
    payment = await resolveRacePaymentByProviderRef(db, orderId, { throwOnError: true })
  } catch (e) {
    logWarn('revolut-race-webhook', 'race_payments lookup failed; deferred', { err: e, orderId, event })
    return NextResponse.json({ success: true, deferred: true })
  }
  if (!payment) {
    // Another flow's order (cars, class bookings, offers, donations) or a
    // stale id. Normal traffic, so no log; 200 so Revolut moves on.
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Idempotency (mig 107). Distinct provider key from the cars
  // Revolut webhook so a single (order, state) pair can't collide
  // across the two routes. Taken after the resolve, before any write: two
  // deliveries of the same (event, order) still serialise on this insert.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_RACE,
    eventId,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Give the claim back and answer 200.
  const defer = async () => {
    await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.REVOLUT_RACE, eventId })
    return NextResponse.json({ success: true, deferred: true })
  }

  // Refresh authoritative state from Revolut (webhook payload omits
  // amount on some events).
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    logWarn('revolut-race-webhook', `getOrder failed for ${orderId}`, { err: e })
    return await defer()
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  const state = String(order.state || '').toLowerCase()
  let result
  try {
    result = await markRacePaymentStatus({
      db,
      payment,
      revolutState: state,
      revolutAmount: Number.isFinite(order.amount) ? order.amount : null,
    })
  } catch (e) {
    logError('revolut-race-webhook', `mark failed for order ${orderId}`, { err: e, paymentId: payment.id })
    return await defer()
  }
  // The status write failed (markRacePaymentStatus logged it): nothing was
  // applied, so release and let a resend or the return-page refresh apply it.
  if (result?.error) return await defer()

  // On a fresh completion, fire the confirmations. Idempotent inside
  // sendRaceConfirmations via the *_sent_at stamps so a Revolut retry
  // can't double-send.
  let confirmations = null
  // EVENT-MOVE.5 — a paid PRICE DIFFERENCE (kind move_gap) settled its move
  // inside markRacePaymentStatus; it gets the short gap receipt, never the
  // entry confirmation, and never the Glofox push (its people were pushed
  // when the entry was paid).
  if (result.applied?.status === 'completed' && payment.kind === GAP_PAYMENT_KIND) {
    try {
      confirmations = await sendGapPaidEmail({ db, paymentId: payment.id })
    } catch (e) {
      console.warn(`[revolut-race-webhook] gap receipt failed for ${payment.id}: ${e.message}`)
      confirmations = { failed: [`unhandled:${e.message}`] }
    }
  } else if (result.applied?.status === 'completed') {
    try {
      confirmations = await sendRaceConfirmations({ db, paymentId: payment.id })
    } catch (e) {
      console.warn(`[revolut-race-webhook] confirmations failed for ${payment.id}: ${e.message}`)
      confirmations = { failed: [`unhandled:${e.message}`] }
    }

    // GLOFOX3.3 (mig 145). Post-payment Glofox push for opted-in
    // events. Race payments don't push at registration time (would
    // create Glofox accounts for teams that abandon checkout), so
    // the push fires here instead — once payment is confirmed.
    // Best-effort, fire-and-forget. Idempotency: every push routes
    // through findOrCreateGlofoxMember which skips already-linked
    // contacts, so a Revolut retry can't double-push either.
    // after(): the push runs once the response is sent, and Vercel keeps
    // the function alive until it finishes (a floating promise could be cut
    // off when the response returned).
    after(() => pushRaceTeamToGlofox(db, payment.id))
  }

  return NextResponse.json({
    success: true,
    applied: result.applied,
    confirmations,
  })
}

// GLOFOX3.3 (mig 145) — the opted-in event's team, pushed to Glofox after the
// payment completed. Best-effort: logs and never throws.
async function pushRaceTeamToGlofox(db, paymentId) {
  try {
    const { data: pay, error: payErr } = await db
      .from('race_payments')
      .select(`
        id,
        race_registrations:race_registration_id (
          id, team_id,
          race_events:race_event_id ( id, create_in_glofox )
        )
      `)
      .eq('id', paymentId)
      .maybeSingle()
    if (payErr) {
      logWarn('revolut-race-webhook.glofox', 'payment unreadable; Glofox push skipped', { err: payErr, paymentId })
      return
    }
    const race = pay?.race_registrations?.race_events
    const teamId = pay?.race_registrations?.team_id
    if (!race?.create_in_glofox || !teamId) return
    const { findOrCreateGlofoxMember } = await import('@/lib/glofox-push')
    const { data: members, error: membersErr } = await db
      .from('team_members')
      .select(`
        name, email, role, contact_id,
        contacts:contact_id ( id, name, email, first_name, last_name, phone, dob, location_id, glofox_member_id )
      `)
      .eq('team_id', teamId)
    if (membersErr) {
      logWarn('revolut-race-webhook.glofox', 'team unreadable; Glofox push skipped', { err: membersErr, paymentId, teamId })
      return
    }
    for (const m of (members || [])) {
      if (!m.contacts || !m.contacts.id || !m.contacts.email) continue
      const c = m.contacts
      let { first_name, last_name } = c
      if ((!first_name || !last_name) && (c.name || m.name)) {
        const full = (c.name || m.name).trim().split(/\s+/)
        first_name = first_name || full[0] || ''
        last_name = last_name || (full.slice(1).join(' ') || '—')
      }
      try {
        await findOrCreateGlofoxMember({
          db,
          locationId: c.location_id,
          contact: { ...c, first_name, last_name },
          source: 'event_registration',
          createIfMissing: true,
          attachTrial: true,
        })
      } catch (e) {
        logWarn('revolut-race-webhook.glofox', `push failed for ${c.email}`, { err: e })
      }
    }
  } catch (e) {
    logWarn('revolut-race-webhook.glofox', `glofox push failed for ${paymentId}`, { err: e })
  }
}

// Revolut hits GET when configuring the webhook URL — return 200 so
// they consider it valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'race-payments revolut webhook endpoint' })
}
