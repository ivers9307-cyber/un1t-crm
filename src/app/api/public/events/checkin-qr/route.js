// GET /api/public/events/checkin-qr?t=<signed token> — PNG QR for an
// attendee's check-in (EVENT-CHECKIN.B). Public so it renders inside
// confirmation emails; the token is HMAC-signed (only the server mints them)
// and the QR merely opens a STAFF-only scan page, so exposing the image is safe.

import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { getAppUrl } from '@/lib/app-url'
import { verifyCheckinToken } from '@/lib/event-checkin-tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const url = new URL(request.url)
  const token = url.searchParams.get('t') || ''
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const payload = verifyCheckinToken(token, secret)
  if (!payload) {
    return NextResponse.json({ success: false, error: 'Invalid check-in code' }, { status: 400 })
  }

  let origin = ''
  try { origin = new URL(getAppUrl()).origin } catch { origin = '' }
  const scanUrl = `${origin}/events/${payload.eventId}/checkin/scan?t=${encodeURIComponent(token)}`

  const png = await QRCode.toBuffer(scanUrl, { width: 600, margin: 2 })
  return new NextResponse(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  })
}
