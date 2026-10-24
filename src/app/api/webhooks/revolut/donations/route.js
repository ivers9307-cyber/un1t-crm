// POST /api/webhooks/revolut/donations
//
// SEPARATE Revolut webhook receiver for event-page card donations (CHARITY.7).
// Register this URL as its own webhook endpoint in Revolut (returns its own
// signing_secret → REVOLUT_DONATION_WEBHOOK_SECRET; falls back to the shared
// REVOLUT_WEBHOOK_SECRET). Mirrors /api/webhooks/revolut/offer-payments —
// signature-verify → dedupe → resolve → getOrder → mark.
//
// After the mark the row is RE-READ and, whenever it is 'paid', the
// stamp-keyed side effects run (contact, consent, receipt) — on every
// observation, fresh or not: the dedupe key differs per Revolut event name, so
// a second delivery lands here on an already-paid row, and the stamps are what
// make the effects idempotent. Returns 200 on anything unrecognised or
// unreadable so Revolut doesn't auto-disable the hook; the status poll
// (/api/public/donations/[id]) recovers a donor whose webhook never completed.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import {
  DONATION_COLS,
  resolveDonationByRef,
  markDonationPaymentStatus,
  runPaidDonationSideEffects,
} from '@/lib/donation-payments'
import { resolveCharitySettings } from '@/lib/charity-donations'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const EVENT_COLS = 'id, name, slug, location_id, host_id, sending_location_id, charity_enabled, charity, payment_currency'

// Read whatever the event's charity switch says now: the money was taken.
async function readEvent(db, donation) {
  const { data, error } = await db.from('race_events').select(EVENT_COLS).eq('id', donation.race_event_id).maybeSingle()
  if (error || !data) {
    logWarn('donation-webhook', 'event row unreadable', { donationId: donation.id, err: error })
    return null
  }
  return data
}

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  // Dedicated secret first, shared merchant secret as the fallback so the
  // route verifies before REVOLUT_DONATION_WEBHOOK_SECRET is set in Vercel.
  const secrets = [
    process.env.REVOLUT_DONATION_WEBHOOK_SECRET,
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

  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.REVOLUT_DONATION,
    eventId: `${event}:${orderId}`,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  const donation = await resolveDonationByRef(db, orderId)
  if (!donation) {
    // Misrouted webhook from another Revolut flow, or a stale id — 200 so
    // Revolut moves on.
    logWarn('donation-webhook', `no donations row for order ${orderId}`, { event })
    return NextResponse.json({ success: true, skipped: 'unknown_order' })
  }

  // Refresh authoritative state from Revolut (payload state can be stale
  // during retries).
  let order
  try {
    order = await getOrder(orderId)
  } catch (e) {
    logWarn('donation-webhook', `getOrder failed for ${orderId}`, { err: e })
    return NextResponse.json({ success: true, deferred: true })
  }
  if (!order) return NextResponse.json({ success: true, skipped: 'order_missing' })

  // The event row supplies the match multiplier snapshotted onto a paid row
  // and the side effects' charity settings. Without it nothing is written;
  // 200 so the provider redelivers.
  const race = await readEvent(db, donation)
  if (!race) return NextResponse.json({ success: true, deferred: true })

  const providerState = String(order.state || '').toLowerCase()
  const { status } = await markDonationPaymentStatus({
    db, donation, providerState,
    providerAmount: Number.isFinite(order.amount) ? order.amount : null,
    multiplier: resolveCharitySettings(race).match_multiplier,
  })

  // Re-read: the side effects get the row as stored, never a guess.
  const { data: fresh, error: readErr } = await db.from('donations').select(DONATION_COLS).eq('id', donation.id).maybeSingle()
  if (readErr || !fresh) {
    logWarn('donation-webhook', 're-read after mark failed', { donationId: donation.id, err: readErr })
    return NextResponse.json({ success: true, state: status })
  }

  if (fresh.status === 'paid') {
    // A contact/receipt failure must never 500 the webhook.
    try {
      await runPaidDonationSideEffects({ db, donation: fresh, race, ipAddress: null })
    } catch (e) {
      logWarn('donation-webhook', `paid side-effects failed for ${donation.id}`, { err: e })
    }
  }

  return NextResponse.json({ success: true, state: fresh.status })
}

// Revolut hits GET when configuring the webhook URL — return 200 so they
// consider it valid.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'donations revolut webhook endpoint' })
}
