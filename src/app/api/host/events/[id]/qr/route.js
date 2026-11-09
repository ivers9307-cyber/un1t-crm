// GET /api/host/events/[id]/qr — printable QR PNG of one of the host's own
// event pages, tagged utm_source=qr so poster scans show up as "QR code" on
// Insights (HOSTPORTAL.4). Host session only; another host's event is 404.
//
// Mirrors src/app/api/host/signup-qr/route.js on PNG geometry (800×800,
// margin 2, ECC 'M', black on white) and the origin-only URL build on the
// host's ANCHOR location's tenant host, the same URL the Promote tab shows.

import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent } from '@/lib/host-portal'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { taggedEventUrl, QR_SOURCE } from '@/lib/event-share-links'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const event = await loadHostEvent(db, session.host.id, params.id, 'id, host_id, slug')
  if (!event) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!event.slug) return NextResponse.json({ success: false, error: 'This event has no public link yet.' }, { status: 404 })

  let publicUrl
  try {
    const { data: hostRow, error } = await db
      .from('event_hosts')
      .select('anchor_location_id')
      .eq('id', session.host.id)
      .maybeSingle()
    if (error) throw error
    const baseUrl = new URL(await resolveCustomerBaseUrl(db, hostRow?.anchor_location_id || null)).origin
    publicUrl = taggedEventUrl(`${baseUrl}/event/${event.slug}`, QR_SOURCE)
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
    return NextResponse.json({ success: false, error: `QR generation failed: ${e?.message || 'unknown'}` }, { status: 500 })
  }

  return new NextResponse(png, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Content-Disposition': `attachment; filename="${event.slug}-qr.png"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
