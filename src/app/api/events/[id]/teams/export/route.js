// GET /api/events/[id]/teams/export
//
// Download the event's attendee list as a CSV — one row per team member, with
// the booking/team columns repeated (name, email, role, membership, booking
// phone). Same auth + data as the /api/events/[id]/teams manage view: session
// user with the `races` permission + location access. (EVENTS-EXPORT.1)

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { buildAttendeeCsv } from '@/lib/attendee-csv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE = 1000
// UTF-8 BOM so Excel renders accented names correctly.
const BOM = '﻿'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, location_id, name, slug, race_date')
    .eq('id', params.id)
    .single()
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard

  // Registrations — range-paginated so a large event never silently truncates
  // at the 1000-row select cap.
  const regs = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select(`
        id, status, registered_at, wave_id,
        teams:team_id ( id, name, size, team_members ( id, name, email, role, is_member ) ),
        wave:wave_id ( id, start_time, label )
      `)
      .eq('race_event_id', params.id)
      .order('registered_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    regs.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  // Attach the latest payment's contact phone per registration (the only phone
  // captured — individual team members don't have their own).
  const regIds = regs.map((r) => r.id)
  if (regIds.length > 0) {
    const phoneByReg = {}
    for (let from = 0; ; from += PAGE) {
      const { data } = await db
        .from('race_payments')
        .select('race_registration_id, contact_phone, created_at')
        .in('race_registration_id', regIds)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)
      for (const pmt of (data || [])) {
        if (!(pmt.race_registration_id in phoneByReg)) phoneByReg[pmt.race_registration_id] = pmt.contact_phone || null
      }
      if (!data || data.length < PAGE) break
    }
    for (const r of regs) r.payment = { contact_phone: phoneByReg[r.id] || null }
  }

  const csv = buildAttendeeCsv({ name: race.name, race_date: race.race_date }, regs)
  const safe = String(race.slug || race.name || 'event')
    .replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'event'

  return new Response(BOM + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}-attendees.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
