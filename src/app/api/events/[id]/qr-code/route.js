// GET /api/events/[id]/qr-code
//
// Returns a PNG QR code that points at the public signup URL for the
// event (/event/[slug]). Operator clicks "Download QR" on the event
// edit form and gets a printable QR ready for posters / table tents /
// in-app sharing.
//
// Manager+ at the event's location. Race-only feature gate? No — the
// QR is just a link to the public signup page, which exists for every
// event kind, so all kinds qualify.
//
// PNG dimensions: 800×800 with quiet-zone margin of 2 modules. Big
// enough to print at A5 size at 200dpi, small enough that a 300dpi
// A4 print is still scannable. ECC level 'M' (15% redundancy) — good
// trade between density and tolerance to print smudges / phone-camera
// shake.

import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: event, error } = await db
    .from('race_events')
    .select('id, slug, name, location_id, active')
    .eq('id', params.id)
    .single()
  if (error || !event) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, event.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Build the public signup URL. Origin-only from getAppUrl so a
  // misconfigured env var (full URL with path/query pasted in) can't
  // poison the QR target — same defensive pattern as the events index
  // public-link rendering.
  let publicUrl
  try {
    const origin = new URL(getAppUrl()).origin
    publicUrl = `${origin}/event/${event.slug}`
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

  // Filename uses the slug so multiple downloads stay distinct on disk:
  // "qr-hyrox-may-2026.png" rather than "qr-code.png".
  const safeSlug = (event.slug || event.id).replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const filename = `qr-${safeSlug}.png`

  return new NextResponse(png, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
