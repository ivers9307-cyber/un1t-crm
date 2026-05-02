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
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendSms, TwilioError } from '@/lib/twilio'
import { getDepositBaseUrl, getRequestOrigin } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  amount: z.number().positive().max(100000).optional(),  // hard upper guard
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select('*, locations(id, name, car_deposit_default_amount)')
    .eq('id', params.id)
    .single()
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

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
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
  const expiresAt = isAlreadyPaid ? car.deposit_token_expires_at : new Date(Date.now() + TWENTY_FOUR_HOURS_MS).toISOString()

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
  const carLabel = [car.make, car.model, car.irish_reg].filter(Boolean).join(' ').trim() || 'your Tesla'
  const buyerFirstName = (car.buyer_name || '').split(' ')[0] || 'there'

  // SMS body — kept under 160 chars to fit a single segment where
  // possible (varies with car name length). Twilio bills per segment;
  // operators care about cost.
  const smsBody = `Hi ${buyerFirstName}, your €${amount.toFixed(2)} Tesla Car Deposit for ${carLabel}: ${link} (link valid 24h)`

  let smsResult = null
  try {
    smsResult = await sendSms({ to: car.buyer_phone, body: smsBody })
  } catch (e) {
    const status = e instanceof TwilioError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    return NextResponse.json({
      success: false,
      error: `SMS delivery failed: ${e.message || 'unknown'}${e.code ? ` (Twilio code ${e.code})` : ''}`,
    }, { status })
  }

  updates.deposit_link_sent_via = 'sms'
  await db.from('cars').update(updates).eq('id', car.id)

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
    console.warn(`[issue-deposit-link] failed to write car_notes entry: ${e.message}`)
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
