// POST /api/cars/[id]/issue-deposit-link
//
// Sets up (or refreshes) a tokenised deposit link on a car and
// delivers it to the buyer via SMS (Twilio). Stamps
// deposit_link_sent_at + deposit_link_sent_via='sms' on success.
//
// Body (optional): { amount?: number }   amount in EUR (defaults to
//   the location's car_deposit_default_amount).
//
// Token rotation (mig 047): each issue generates a fresh deposit_token
// and stamps deposit_token_expires_at = NOW() + 24h. Old links go
// dead. A system note is added to car_notes containing the new URL
// so operators can copy / re-test / re-share without re-clicking
// the issue button.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendLocationSms, TwilioError } from '@/lib/twilio'
import { getDepositBaseUrl, getRequestOrigin } from '@/lib/app-url'
import { syncOrderFromCarDeposit } from '@/lib/orders'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'
import { logWarn } from '@/lib/log'
import { buildDepositSmsBody } from '@/lib/deposit-receipts'
import { validateBody } from '@/lib/validate'
import { overlayConnections } from '@/lib/connection-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  amount: z.number().positive().max(100000).optional(),  // hard upper guard
})

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const validation = await validateBody(request, Body, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select('*, locations(id, name, car_deposit_default_amount, twilio_alpha_sender_id)')
    .eq('id', params.id)
    .single()
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard

  // INTEG-A2 dual-read: registry twilio_sender row first.
  if (car.locations) {
    car.locations = await overlayConnections(db, car.locations, ['twilio_sender'])
  }

  // Hard requirement — SMS is the only channel now. No fallback to
  // email because the operator chose to standardise on one channel
  // (one delivery story, one receipt, one cost line).
  if (!car.buyer_phone) {
    return NextResponse.json({
      success: false,
      error: 'Add a buyer phone number before issuing a deposit link.',
    }, { status: 400 })
  }

  const amount = parsed.data.amount ?? Number(car.deposit_amount) ?? Number(car.locations?.car_deposit_default_amount) ?? 500

  // Rotate the token on every issue (mig 047). Each link expires 24h
  // after this issue, and reissuing invalidates the previous URL —
  // limits the blast radius if a link is forwarded somewhere it
  // shouldn't be. Once a deposit is paid, leave the token alone so
  // the receipt page on the public URL keeps working.
  const isAlreadyPaid = car.deposit_status === 'paid'
  const token = isAlreadyPaid && car.deposit_token ? car.deposit_token : randomUUID()
  // 72 hours is the buyer-facing window — long enough that a buyer
  // can sleep on it / talk to a partner / sort funds, short enough
  // that the dealer doesn't have a forest of dormant unpaid links.
  // Paid deposits keep their existing expiry untouched (the receipt
  // page renders forever for any status='paid' regardless of the
  // expiry timestamp).
  const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000
  const expiresAt = isAlreadyPaid ? car.deposit_token_expires_at : new Date(Date.now() + SEVENTY_TWO_HOURS_MS).toISOString()

  // Persist the token + expiry + amount + reset status so this issue
  // act becomes the new source of truth. Acceptance / payment columns
  // are NOT cleared — those represent historical evidence for any
  // previous successful deposit that we don't want to lose.
  // Token rotation also invalidates any in-flight Revolut order id
  // since it was created against the old token's idempotency key.
  const updates = {
    deposit_token: token,
    deposit_token_expires_at: expiresAt,
    deposit_amount: amount,
    deposit_status: isAlreadyPaid ? 'paid' : 'sent',
    deposit_link_sent_at: new Date().toISOString(),
    deposit_revolut_order_id: isAlreadyPaid ? car.deposit_revolut_order_id : null,
    deposit_revolut_checkout_url: isAlreadyPaid ? car.deposit_revolut_checkout_url : null,
  }

  // Buyer-facing deposit links use the dedicated payment domain
  // (DEPOSIT_BASE_URL). Falls back to the incoming request origin if
  // no deposit base URL env var is set so a misconfigured deploy
  // still produces working links.
  let baseUrl
  try { baseUrl = getDepositBaseUrl() } catch { baseUrl = getRequestOrigin(request) }
  const link = `${baseUrl}/deposit/${token}`
  const carLabel = [car.make, car.model, car.irish_reg].filter(Boolean).join(' ').trim() || 'your car'
  const buyerFirstName = (car.buyer_name || '').split(' ')[0] || 'there'

  // SMS body — kept under 160 chars to fit a single segment where
  // possible (varies with car name length). Twilio bills per segment;
  // operators care about cost.
  const smsBody = buildDepositSmsBody({ firstName: buyerFirstName, amount, carLabel, link })

  // Sender is resolved from car.locations.twilio_alpha_sender_id
  // (mig 059) — falls back to TWILIO_FROM env then the literal
  // 'CCFautos' if neither is set. CCF Autos's location row has
  // 'CCFautos' so behaviour is unchanged unless an admin edits it
  // in Settings → Locations → SMS.
  let smsResult = null
  try {
    smsResult = await sendLocationSms({ location: car.locations, to: car.buyer_phone, body: smsBody })
  } catch (e) {
    const status = e instanceof TwilioError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    return NextResponse.json({
      success: false,
      error: `SMS delivery failed: ${e.message || 'unknown'}${e.code ? ` (Twilio code ${e.code})` : ''}`,
    }, { status })
  }

  updates.deposit_link_sent_via = 'sms'
  await db.from('cars').update(updates).eq('id', car.id)

  // Project into the generic orders ledger (mig 085) so the
  // /orders Pending tab shows this even before the buyer pays.
  // Best-effort — never breaks the issue flow.
  try {
    const carForOrders = { ...car, ...updates, deposit_amount: amount }
    await syncOrderFromCarDeposit({ db, car: carForOrders })
    if (car.buyer_email) {
      await emitEvent({
        db,
        eventType: EVENT_TYPES.ORDER_CREATED,
        contactEmail: car.buyer_email,
        locationId: car.location_id,
        sourceType: 'car_deposit',
        sourceId: car.id,
        metadata: { amount_cents: Math.round(amount * 100), currency: 'EUR' },
      })
    }
  } catch (e) {
    logWarn('issue-deposit-link', `orders/events sync failed for car ${car.id}`, { err: e })
  }

  // Drop a system note on the car timeline so the operator can copy
  // the link back later (testing, manual reshare, etc.). Best-effort —
  // a notes-table failure shouldn't fail the issue flow itself.
  try {
    const expiryHint = expiresAt
      ? ` (expires ${new Date(expiresAt).toLocaleString('en-IE')})`
      : ''
    await db.from('car_notes').insert({
      car_id: car.id,
      location_id: car.location_id,
      kind: 'system',
      created_by: user.id,
      content: `Deposit link issued — €${amount.toFixed(2)}. Sent via SMS to ${car.buyer_phone} (Twilio sid ${smsResult?.sid || 'unknown'}).\n${link}${expiryHint}`,
    })
  } catch (e) {
    logWarn('issue-deposit-link', `failed to write car_notes entry`, { err: e })
  }

  return NextResponse.json({
    success: true,
    sent_via: ['sms'],
    link,
    amount,
    expires_at: expiresAt,
    sms: { sid: smsResult?.sid, status: smsResult?.status, to: smsResult?.to },
  })
}
