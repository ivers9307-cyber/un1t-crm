// GET /api/public/events/checkin-qr?t=<signed token> — PNG QR for an
// attendee's check-in (EVENT-CHECKIN.B). Public so it renders inside
// confirmation emails; the token is HMAC-signed (only the server mints them)
// and the QR merely opens a STAFF-only scan page, so exposing the image is safe.

import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { getAppUrl } from '@/lib/app-url'
import { verifyCheckinToken } from '@/lib/event-checkin-tokens'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const url = new URL(request.url)
  const token = url.searchParams.get('t') || ''
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  const payload = secret ? verifyCheckinToken(token, secret) : null
  if (!payload) {
    return NextResponse.json({ success: false, error: 'Invalid check-in code' }, { status: 400 })
  }

  // Abuse limiter (audit H2a) — placed AFTER the HMAC verify on purpose: an
  // invalid token 400s without a DB round-trip (cheaper than the limiter
  // itself, and unsignable tokens can't be enumerated), so the limiter only
  // guards the CPU-bound QR render. Sized 120-per-5-min per IP, 4x the usual
  // public-GET 30: this image is embedded in confirmation emails, and mail
  // providers proxy image fetches through shared IPs (e.g. GoogleImageProxy)
  // — many recipients can legitimately fan in from one address. Cache-Control
  // below lets those proxies re-serve without re-fetching. Fails open inside
  // checkRateLimit so a limiter outage never breaks a buyer's pass.
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `checkin-qr:${ip}`, { max: 120, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  let origin = ''
  try { origin = new URL(getAppUrl()).origin } catch { origin = '' }
  const scanUrl = `${origin}/events/${payload.eventId}/checkin/scan?t=${encodeURIComponent(token)}`

  const png = await QRCode.toBuffer(scanUrl, { width: 600, margin: 2 })
  return new NextResponse(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  })
}
