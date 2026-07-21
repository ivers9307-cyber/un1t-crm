import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { verifyMetaSignature } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { parseInstagramEvents, handleInstagramInbound } from '@/lib/agent/instagram'

// RADAR-AGENT — Instagram messaging webhook (Meta Messenger Platform).
// GET = hub verification; POST = inbound DMs. Mirrors the WhatsApp
// webhook posture: signature-checked, per-message idempotency, always
// 200 to Meta, never throws.

export const runtime = 'nodejs'

// GET — Meta webhook verification handshake.
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  // Reuse the WhatsApp verify token if an IG-specific one isn't set, so
  // a single Meta app can verify both without extra config.
  const verifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
    || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  if (!verifyToken) {
    console.error('No Instagram/WhatsApp webhook verify token set — refusing verification')
    return NextResponse.json({ success: false, error: 'Server misconfigured' }, { status: 500 })
  }
  if (mode === 'subscribe' && token === verifyToken) {
    return new Response(challenge, { status: 200 })
  }
  return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
}

// POST — inbound Instagram messaging events.
export async function POST(request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  const appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.WHATSAPP_APP_SECRET

  // Fail CLOSED: a missing app secret means we cannot authenticate Meta,
  // so refuse rather than accept spoofable inbound (which could drive the
  // agent). 500 (not 403) so Meta retries for ~24h and recovery is just
  // setting the env var — mirrors the Postmark webhook posture.
  if (!appSecret) {
    console.error('[security] No INSTAGRAM_APP_SECRET / WHATSAPP_APP_SECRET set — refusing IG webhook (fail closed).')
    return NextResponse.json({ success: false, error: 'Server misconfigured' }, { status: 500 })
  }
  const result = verifyMetaSignature(rawBody, signature, appSecret)
  if (!result.ok) {
    console.warn(`Instagram webhook rejected: ${result.reason}`)
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 403 })
  }

  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const db = createServerClient()
  try {
    const events = parseInstagramEvents(body)
    for (const ev of events) {
      // Per-message idempotency — Meta retries the envelope on non-2xx.
      if (ev.messageId) {
        const dedup = await recordWebhookEvent({
          db, provider: WEBHOOK_PROVIDERS.INSTAGRAM,
          eventId: `msg:${ev.messageId}`,
        })
        if (dedup.seen) continue
      }
      await handleInstagramInbound(db, ev)
    }
  } catch (err) {
    console.error('Instagram webhook error:', err?.message, err?.stack)
  }

  // Always 200 — Meta retries non-200.
  return NextResponse.json({ success: true })
}
