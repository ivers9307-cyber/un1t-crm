// POST /api/webhooks/inbody — InBody / Lookin'Body WebAPI scan-completed
// notification (Step 3 of the InBody API-KEY setup).
//
// Public path (middleware allows /api/webhooks/). Authenticated by the custom
// secret header we configure in the InBody portal (Step 3) vs the
// INBODY_WEBHOOK_SECRET env var. The webhook is a NOTIFY (no measurements) —
// we capture every notification into inbody_webhook_events (matched or not);
// a later enrich step pulls the actual scan data from the Lookin'Body REST API
// into inbody_scans.
//
// Returns 200 on a valid, captured notification — including InBody's own setup
// test payload (an unmatched phone) so the operator can pass Step 4 and save.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyInbodySecret, parseInbodyNotification } from '@/lib/inbody-webhook'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'

export const runtime = 'nodejs'

export async function POST(request) {
  // Read the raw body first so a malformed payload can't throw before auth.
  const raw = await request.text()

  const secret = process.env.INBODY_WEBHOOK_SECRET
  if (!secret) {
    // Misconfig — fail loud (5xx) so it surfaces in the portal's test instead
    // of silently accepting unauthenticated posts.
    console.error('[inbody] INBODY_WEBHOOK_SECRET is not set')
    return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 500 })
  }

  // The header key is whatever was set in the InBody portal (Step 3); we use
  // `x-inbody-secret`. Header names are case-insensitive.
  if (!verifyInbodySecret(request.headers.get('x-inbody-secret'), secret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  let body
  try { body = raw ? JSON.parse(raw) : {} } catch { body = { _unparsed: raw } }
  const n = parseInbodyNotification(body)

  const db = createServerClient()
  // Idempotent capture — a re-sent notification collides on the dedup index.
  try {
    const { error } = await db
      .from('inbody_webhook_events')
      .upsert({
        account: n.account,
        tel_hp: n.telHp,
        user_id: n.userId,
        test_datetime: n.testDatetime,
        equip: n.equip,
        equip_serial: n.equipSerial,
        is_temp_data: n.isTempData,
        payload: body,
        processed: false,
      }, { onConflict: 'account,user_id,test_datetime', ignoreDuplicates: true })

    if (error) {
      console.error('[inbody] capture failed:', error.message)
      await deadLetterWebhook(db, {
        provider: 'inbody',
        eventType: n.account || null,
        payload: body,
        error,
      })
      // Return 200 so InBody does not disable the webhook on repeated failures.
      return NextResponse.json({ success: true, status: 'capture_failed' }, { status: 200 })
    }
  } catch (e) {
    console.error('[inbody] capture threw:', e?.message)
    await deadLetterWebhook(db, {
      provider: 'inbody',
      eventType: n.account || null,
      payload: body,
      error: e,
    })
    // Return 200 so InBody does not disable the webhook on repeated throws.
    return NextResponse.json({ success: true, status: 'capture_failed' }, { status: 200 })
  }

  return NextResponse.json({ success: true }, { status: 200 })
}
