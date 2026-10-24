// GET /api/public/donations/[id] — CHARITY.6: public, read-only status of one
// donation for the page's embedded checkout and `?donation=<id>` return state
// to poll. The UUID is the capability token. Display-safe fields only: NO donor
// field (name, email, message) is ever returned. While the payment is pending
// it re-checks the provider (rate-capped per donation) so the UI can advance
// before the webhook lands. Every observation of a paid row runs the
// stamp-keyed side effects (contact, consent, receipt): the stamps make that
// idempotent, and it is what recovers a donor whose webhook never landed. In
// the first minute after paid_at only the observer that flipped the row runs
// them (observerWon), so the poll and the webhook do not both send a receipt.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { paymentsFor } from '@/lib/payments'
import { DONATION_COLS, markDonationPaymentStatus, runPaidDonationSideEffects } from '@/lib/donation-payments'
import { donationPublicState, resolveCharitySettings } from '@/lib/charity-donations'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const EVENT_COLS = 'id, name, slug, location_id, host_id, sending_location_id, charity_enabled, charity, payment_currency'

async function readDonation(db, id) {
  return db.from('donations').select(DONATION_COLS).eq('id', id).maybeSingle()
}

// The event is read whatever its charity switch says now: the money was taken.
async function readEvent(db, donation) {
  const { data, error } = await db.from('race_events').select(EVENT_COLS).eq('id', donation.race_event_id).maybeSingle()
  if (error || !data) {
    logWarn('donation-poll', 'event row unreadable', { donationId: donation.id, err: error })
    return null
  }
  return data
}

export async function GET(request, props) {
  const { id } = await props.params
  const db = createServerClient()
  const { data, error } = await readDonation(db, id)
  if (error || !data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let row = data
  const canRecheck = row.status === 'awaiting_payment'
    && (row.payment_provider === 'revolut' || row.payment_provider === 'stripe_connect')
    && !!row.payment_provider_ref
  const recheckAllowed = canRecheck
    // The embedded checkout polls every 3 s while the donor types: 100 per 5
    // minutes covers the whole window, so a slow 3DS payment is still seen.
    ? (await checkRateLimit(db, `dpoll:${id}`, { max: 100, windowMs: 5 * 60_000 })).allowed
    : false
  let race = null
  // True only when THIS poll's mark flipped the row (see runPaidDonationSideEffects).
  let observerWon = false
  if (recheckAllowed) {
    try {
      const norm = await paymentsFor(row.payment_provider).getPayment(row.payment_provider_ref, { connectedAccountId: row.connected_account_id || null })
      if (norm) {
        race = await readEvent(db, row)
        if (race) {
          const marked = await markDonationPaymentStatus({
            db, donation: row, providerState: norm.state,
            providerAmount: Number.isFinite(norm.amountCents) ? norm.amountCents : null,
            multiplier: resolveCharitySettings(race).match_multiplier,
          })
          observerWon = marked?.changed === true
          // Re-read: the side effects get the row as stored, never a guess.
          const { data: fresh } = await readDonation(db, id)
          if (fresh) row = fresh
        }
      }
    } catch (e) { logWarn('donation-poll', 're-check failed', { err: e, donationId: id }) }
  }

  if (row.status === 'paid') {
    try {
      race = race || await readEvent(db, row)
      if (race) await runPaidDonationSideEffects({ db, donation: row, race, ipAddress: getClientIp(request), observerWon })
    } catch (e) { logWarn('donation-poll', 'paid side effects failed', { err: e, donationId: id }) }
  }

  const awaiting = row.status === 'awaiting_payment' && !!row.payment_provider_ref
  return NextResponse.json({ success: true, data: {
    id: row.id,
    state: donationPublicState(row),
    paid: row.status === 'paid',
    amount_cents: row.amount_cents,
    currency: row.currency,
    match_multiplier: row.match_multiplier,
    checkout: awaiting
      ? { provider: row.payment_provider, token: row.payment_checkout_token, url: row.payment_checkout_url, connectedAccountId: row.connected_account_id || null }
      : null,
  } })
}
