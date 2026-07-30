// GET /api/host/signup-qr — printable QR PNG for the host's public
// mailing-list signup page /h/[slug] (HOST-GROWTH.3). Host session only;
// ensures the slug exists first via ensureHostSlug (same lazy derivation
// the email-domain flow uses).
//
// Mirrors src/app/api/events/[id]/qr-code/route.js on PNG geometry (800×800,
// quiet-zone margin 2, ECC 'M', explicit black-on-white) and the
// origin-only URL build (a misconfigured NEXT_PUBLIC_APP_URL with a
// path/query pasted in can't poison the QR target) — only the gate differs
// (getCurrentHost + own row instead of getCurrentUser + permission check).

import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { ensureHostSlug } from '@/lib/hosts'
import { getAppUrl } from '@/lib/app-url'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: hostRow } = await db
    .from('event_hosts')
    .select('id, name, slug')
    .eq('id', session.host.id)
    .maybeSingle()
  if (!hostRow) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let slug
  try {
    slug = await ensureHostSlug(db, hostRow)
  } catch (e) {
    logError('host-signup-qr', 'slug ensure failed', { err: e })
    return NextResponse.json({ success: false, error: 'Could not prepare your signup page — try again shortly.' }, { status: 500 })
  }

  // Origin-only from getAppUrl, same defensive pattern as the events QR
  // route — a misconfigured env var can't poison the QR target.
  let publicUrl
  try {
    const origin = new URL(getAppUrl()).origin
    publicUrl = `${origin}/h/${slug}`
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: `Cannot build public URL — check NEXT_PUBLIC_APP_URL is configured. (${e?.message || 'invalid'})`,
    }, { status: 500 })
  }

  let png
  try {
    png = await QRCode.toBuffer(publicUrl, {
      type: 'png',
      width: 800,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    })
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: `QR generation failed: ${e?.message || 'unknown'}`,
    }, { status: 500 })
  }

  return new NextResponse(png, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Content-Disposition': `attachment; filename="signup-qr-${slug}.png"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
