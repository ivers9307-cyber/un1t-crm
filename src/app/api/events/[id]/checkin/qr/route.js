// GET /api/events/[id]/checkin/qr?registration=…&member=… — PNG QR for one
// attendee. Encodes a signed scan URL; staff scan it with any phone camera,
// which opens the check-in landing page. Operator-only (the QR can be shown
// on the roster, printed, or embedded in the attendee's confirmation).

import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { getAppUrl } from '@/lib/app-url'
import { signCheckinToken } from '@/lib/event-checkin-tokens'

export const runtime = 'nodejs'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const registrationId = url.searchParams.get('registration') || ''
  const memberId = url.searchParams.get('member') || ''
  if (!registrationId || !memberId) {
    return NextResponse.json({ success: false, error: 'registration and member are required' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: reg } = await db
    .from('race_registrations')
    .select('id, race_event_id, race_events!inner ( id, location_id ), teams ( id, team_members ( id ) )')
    .eq('id', registrationId)
    .maybeSingle()
  if (!reg || reg.race_event_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Registration not found for this event' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, reg.race_events?.location_id)
  if (guard) return guard
  if (!(reg.teams?.team_members || []).some((m) => m.id === memberId)) {
    return NextResponse.json({ success: false, error: 'That person is not on this registration' }, { status: 400 })
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const token = signCheckinToken({ eventId: params.id, registrationId, memberId }, secret)
  let origin = ''
  try { origin = new URL(getAppUrl()).origin } catch { origin = '' }
  const scanUrl = `${origin}/events/${params.id}/checkin/scan?t=${encodeURIComponent(token)}`

  const png = await QRCode.toBuffer(scanUrl, { width: 600, margin: 2 })
  return new NextResponse(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' },
  })
}
