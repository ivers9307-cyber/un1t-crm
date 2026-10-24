// POST /api/public/events/[slug]/donate — CHARITY.5: start a card donation from
// the public event page. The event comes from the slug (published + active
// only); registration state is irrelevant, so a closed or full event still
// takes a gift. The amount is the donor's, but bounded by the OPERATOR's
// min/max (or their preset list when custom amounts are off), checked after
// the event is read. Inserts an `awaiting_payment` row with contact_id left
// NULL (the paid-side-effects runner links the contact once the money is in)
// and opens the provider payment. The signed webhook or the status route
// settles the row. No auth; rate-limited per event slug and IP.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { eventIsPublic } from '@/lib/host-events'
import { resolveCharitySettings } from '@/lib/charity-donations'
import { createDonationPayment, DONATION_COLS } from '@/lib/donation-payments'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  amount_cents: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  message: z.string().trim().max(280).optional(),
  marketing_opt_in: z.boolean().optional(),
  attribution: z.record(z.string(), z.unknown()).optional(),
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
  const limit = await checkRateLimit(db, `donate:${slug}:${ip}`, { max: 10, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many attempts. Please wait a few minutes and try again.')

  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, slug, name, kind, location_id, active, status, payment_currency,
      charity_enabled, charity, host_id,
      host:event_hosts!host_id ( id, name, organization_id, payment_provider, charges_enabled, stripe_connected_account_id )
    `)
    .eq('slug', slug)
    .eq('active', true)
    .eq('status', 'published')
    .single()
  if (raceErr || !race || !eventIsPublic(race)) return fail(404, 'not_found', 'Event not found')

  const settings = resolveCharitySettings(race)
  if (!settings.enabled) return fail(400, 'not_enabled', 'Donations are not open for this event.')

  const amount = b.amount_cents
  const inBounds = amount >= settings.min_cents && amount <= settings.max_cents
  const allowed = settings.custom_allowed
    ? inBounds
    : Array.isArray(settings.presets_cents) && settings.presets_cents.includes(amount)
  if (!allowed) return fail(400, 'invalid_amount', 'That amount is not available. Please choose another.')

  const { data: row, error: insErr } = await db.from('donations').insert({
    race_event_id: race.id,
    location_id: race.location_id,
    donor_name: b.name,
    donor_email: b.email,
    message: b.message || null,
    amount_cents: amount,
    currency: race.payment_currency || 'EUR',
    status: 'awaiting_payment',
    marketing_opt_in: !!b.marketing_opt_in,
    attribution: b.attribution || null,
  }).select(DONATION_COLS).single()
  if (insErr || !row) {
    logError('donate', 'donation insert failed', { err: insErr, raceId: race.id })
    return fail(500, 'unavailable', 'Could not start your donation. Please try again.')
  }

  let payment
  try {
    const returnUrl = `${await resolveCustomerBaseUrl(db, race.location_id)}/event/${slug}?donation=${row.id}`
    payment = await createDonationPayment({ db, donation: row, race, host: race.host || null, returnUrl })
  } catch (err) {
    if (err?.code === 'payments_unavailable') {
      return fail(400, 'payments_unavailable', 'Donations are not available for this event right now.')
    }
    logError('donate', 'payment create failed', { err, donationId: row.id })
    const { error: failErr } = await db.from('donations').update({ status: 'failed' }).eq('id', row.id)
    if (failErr) logWarn('donate', 'could not mark donation failed', { err: failErr, donationId: row.id })
    return fail(502, 'checkout_failed', 'Could not start checkout. Please try again.')
  }

  return NextResponse.json({
    success: true,
    data: { donation: { id: row.id, amount_cents: row.amount_cents, currency: row.currency, checkout: payment.checkout } },
  })
}
