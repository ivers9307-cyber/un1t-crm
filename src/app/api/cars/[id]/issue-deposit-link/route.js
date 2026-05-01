// POST /api/cars/[id]/issue-deposit-link
//
// Sets up (or refreshes) a tokenised deposit link on a car and
// delivers it to the buyer via BOTH email and WhatsApp where data
// allows. Stamps deposit_link_sent_at + deposit_link_sent_via on
// success.
//
// Body (optional): { amount?: number }   amount in EUR (defaults to
//   the location's car_deposit_default_amount).
//
// Idempotency: on a re-issue, the same deposit_token is reused so
// the existing public URL (if already shared) keeps working.
// Status is reset to 'sent' so the buyer can re-attempt payment.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail } from '@/lib/postmark'
import {
  sendTemplateMessage,
  buildTemplateComponents,
  getOrCreateConversation,
} from '@/lib/whatsapp'
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
    .select('*, locations(id, name, car_deposit_default_amount, car_deposit_whatsapp_template_id)')
    .eq('id', params.id)
    .single()
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  if (!car.buyer_email && !car.buyer_phone) {
    return NextResponse.json({
      success: false,
      error: 'Add a buyer email and/or phone before issuing a deposit link.',
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
    // Wipe the cached Revolut order so accept-and-pay creates a fresh
    // one (different idempotency key now). Skipped for already-paid
    // cars so the receipt links stay intact.
    deposit_revolut_order_id: isAlreadyPaid ? car.deposit_revolut_order_id : null,
    deposit_revolut_checkout_url: isAlreadyPaid ? car.deposit_revolut_checkout_url : null,
  }

  // Build the link, then dispatch through both channels in parallel
  // (operator chose 'send to both'). We don't fail the whole call if
  // ONE channel errors — surface the per-channel result so the UI
  // can show e.g. "Email sent ✓ · WhatsApp failed: template missing".
  // Buyer-facing deposit links use the dedicated payment domain
  // (DEPOSIT_BASE_URL). Falls back to NEXT_PUBLIC_APP_URL if unset,
  // and finally to the incoming request origin as a last resort so
  // a misconfigured deploy still produces working links.
  let baseUrl
  try { baseUrl = getDepositBaseUrl() } catch { baseUrl = getRequestOrigin(request) }
  const link = `${baseUrl}/deposit/${token}`
  const carLabel = [car.make, car.model, car.uk_reg || car.irish_reg].filter(Boolean).join(' ').trim() || 'your Tesla'
  const buyerFirstName = (car.buyer_name || '').split(' ')[0] || 'there'

  const sentVia = []
  const errors = []

  // Email — Postmark transactional stream. Inline HTML, no template
  // dependency. Subject + body are kept short on purpose; the link
  // is the action.
  if (car.buyer_email) {
    try {
      const html = renderDepositEmailHtml({ buyerFirstName, carLabel, amount, link })
      await sendTransactionalEmail({
        to: car.buyer_email,
        subject: `Tesla Car Deposit: secure your ${carLabel}`,
        htmlBody: html,
        contactId: null,
        locationId: car.location_id,
        tag: 'car-deposit',
      })
      sentVia.push('email')
    } catch (e) {
      errors.push(`email: ${e.message || 'send failed'}`)
    }
  }

  // WhatsApp — requires the location to have configured a UTILITY
  // template (locations.car_deposit_whatsapp_template_id) with body
  // variables in the agreed order: {{1}}=name, {{2}}=amount,
  // {{3}}=car description, {{4}}=link.
  if (car.buyer_phone) {
    const templateId = car.locations?.car_deposit_whatsapp_template_id
    if (!templateId) {
      errors.push('whatsapp: no template configured for this location (Settings → Location → Car deposit)')
    } else {
      try {
        const { data: tpl } = await db
          .from('whatsapp_templates')
          .select('name, language, components, status, category')
          .eq('id', templateId)
          .single()
        if (!tpl) throw new Error('configured template not found')
        if (tpl.status !== 'APPROVED') throw new Error(`template not approved (${tpl.status})`)
        if (tpl.category === 'MARKETING') throw new Error('configured template is MARKETING category — must be UTILITY')

        // Synthetic 'contact' shape that buildTemplateComponents understands.
        // We're sending to the buyer here, who isn't necessarily a CRM
        // contact row.
        const fakeContact = {
          first_name: buyerFirstName,
          name: car.buyer_name || buyerFirstName,
          phone: car.buyer_phone,
        }
        const variableMapping = { 1: 'first_name', 2: String(amount.toFixed(2)), 3: carLabel, 4: link }
        const components = buildTemplateComponents(tpl, fakeContact, variableMapping)

        await sendTemplateMessage(car.buyer_phone, tpl.name, tpl.language || 'en', components)
        sentVia.push('whatsapp')

        // Best-effort conversation row so outbound shows up in the inbox.
        try { await getOrCreateConversation(db, fakeContact, car.location_id) } catch {}
      } catch (e) {
        errors.push(`whatsapp: ${e.message || 'send failed'}`)
      }
    }
  }

  if (sentVia.length === 0) {
    return NextResponse.json({
      success: false,
      error: `No channels delivered. ${errors.join('; ')}`,
      errors,
    }, { status: 502 })
  }

  updates.deposit_link_sent_via = sentVia.join(',')
  await db.from('cars').update(updates).eq('id', car.id)

  // Drop a system note on the car timeline so the operator can copy
  // the link back later (testing, manual reshare, etc.). Best-effort —
  // a notes-table failure shouldn't fail the issue flow itself.
  try {
    const expiryHint = expiresAt
      ? ` (expires ${new Date(expiresAt).toLocaleString('en-IE')})`
      : ''
    const channelsHint = sentVia.length ? ` Sent via ${sentVia.join(' + ')}.` : ''
    const errsHint = errors.length ? ` Issues: ${errors.join('; ')}.` : ''
    await db.from('car_notes').insert({
      car_id: car.id,
      location_id: car.location_id,
      kind: 'system',
      created_by: user.id,
      content: `Deposit link issued — €${amount.toFixed(2)}.${channelsHint}${errsHint}\n${link}${expiryHint}`,
    })
  } catch (e) {
    console.warn(`[issue-deposit-link] failed to write car_notes entry: ${e.message}`)
  }

  return NextResponse.json({
    success: true,
    sent_via: sentVia,
    errors,                  // partial failures (email ok, WA failed) — surface but don't block
    link,                    // operator may also copy/share manually
    amount,
    expires_at: expiresAt,
  })
}

// ────────────────────────────────────────────────────────────────────
// Inline email body. Plain HTML, no template dep — the deposit email
// is a one-off transactional message and a templated approach here
// would mean editing two systems whenever the wording changes.
// ────────────────────────────────────────────────────────────────────
function renderDepositEmailHtml({ buyerFirstName, carLabel, amount, link }) {
  return `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
  <h1 style="font-size: 22px; margin: 0 0 8px;">Tesla Car Deposit</h1>
  <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;">Hi ${escapeHtml(buyerFirstName)},</p>
  <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;">
    To secure the <strong>${escapeHtml(carLabel)}</strong> we discussed, please pay a non-refundable deposit of
    <strong>€${amount.toFixed(2)}</strong>. This holds the car for you and locks the price in.
  </p>
  <p style="margin: 24px 0;">
    <a href="${link}" style="display: inline-block; background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review terms and pay deposit</a>
  </p>
  <p style="font-size: 13px; line-height: 1.5; color: #555; margin: 0 0 8px;">
    The page asks you to accept the terms (the deposit is non-refundable and secures the car for you), then takes payment securely via Revolut.
  </p>
  <p style="font-size: 13px; color: #999; margin: 24px 0 0;">If the button doesn't work, copy this link: ${link}</p>
</body></html>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
