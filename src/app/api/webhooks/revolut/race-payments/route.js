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
// event to whichever webhook subscribed to it. We use payload
// metadata.domain='un1t_race' as a defensive secondary check so a
// misrouted webhook returns 200/skipped rather than mutating the
// wrong domain.
//
// Auth: each Revolut webhook gets its OWN signing secret. We try
// REVOLUT_RACE_WEBHOOK_SECRET first (the dedicated one for this
// webhook), falling back to REVOLUT_WEBHOOK_SECRET for the
// transition window or single-merchant-account setups. Both are
// passed to verifyWebhookSignature; whichever matches the header
// candidate wins.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { sendRaceConfirmations } from '@/lib/race-confirmations'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'

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

  // Idempotency (mig 107). Distinct provider key from the cars
  // Revolut webhook so a single (order, state) pair can't collide
  // across the two routes (Revolut order_ids are unique per merchant
  // account but we want belt-and-braces if a misroute happens).
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_RACE,
    eventId: `${event}:${orderId}`,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  const payment = await resolveRacePaymentByProviderRef(db, orderId)
  if (!payment) {
    // Could be a cars deposit webhook misrouted here, or a stale id.
    // Return 200 so Revolut moves on. The cars handler at
    // /api/webhooks/revolut owns those.
    console.warn(`[revolut-race-webhook] no race_payment for order ${orderId} (event ${event})`)
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Refresh authoritative state from Revolut (webhook payload omits
  // amount on some events).
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    console.warn(`[revolut-race-webhook] getOrder failed for ${orderId}: ${e.message}`)
    return NextResponse.json({ success: true, skipped: 'getorder_failed' })
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  const state = String(order.state || '').toLowerCase()
  const result = await markRacePaymentStatus({
    db,
    payment,
    revolutState: state,
    revolutAmount: Number.isFinite(order.amount) ? order.amount : null,
  })

  // On a fresh completion, fire the confirmations. Idempotent inside
  // sendRaceConfirmations via the *_sent_at stamps so a Revolut retry
  // can't double-send.
  let confirmations = null
  if (result.applied?.status === 'completed') {
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
    ;(async () => {
      try {
        const { data: pay } = await db
          .from('race_payments')
          .select(`
            id,
            race_registrations:race_registration_id (
              id, team_id,
              race_events:race_event_id ( id, create_in_glofox )
            )
          `)
          .eq('id', payment.id)
          .maybeSingle()
        const race = pay?.race_registrations?.race_events
        const teamId = pay?.race_registrations?.team_id
        if (!race?.create_in_glofox || !teamId) return
        const { findOrCreateGlofoxMember } = await import('@/lib/glofox-push')
        const { logWarn } = await import('@/lib/log')
        const { data: members } = await db
          .from('team_members')
          .select(`
            name, email, role, contact_id,
            contacts:contact_id ( id, name, email, first_name, last_name, phone, dob, location_id, glofox_member_id )
          `)
          .eq('team_id', teamId)
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
        console.warn(`[revolut-race-webhook] glofox push fetch failed for ${payment.id}: ${e.message}`)
      }
    })()
  }

  return NextResponse.json({
    success: true,
    applied: result.applied,
    confirmations,
  })
}

// Revolut hits GET when configuring the webhook URL — return 200 so
// they consider it valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'race-payments revolut webhook endpoint' })
}
