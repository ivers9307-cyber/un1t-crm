// GET /api/public/races/[slug]
//
// Public — no auth. Race details + allowed_team_sizes for the public
// signup form at /race/[slug]. Joins the parent location for the
// info sidebar. Mirrors the shape of /api/public/events/[slug].

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function GET(_request, { params }) {
  const db = createServerClient()
  const { data, error } = await db
    .from('race_events')
    .select(`
      id, name, slug, description, race_date, start_time,
      registration_opens_at, registration_closes_at, capacity,
      allowed_team_sizes, location_id,
      locations:location_id ( id, name, address, timezone )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Compute remaining capacity if a cap is set. Cheap query — no
  // join needed because we count rows in race_registrations.
  let remaining = null
  if (data.capacity != null) {
    const { count } = await db
      .from('race_registrations')
      .select('*', { count: 'exact', head: true })
      .eq('race_event_id', data.id)
      .eq('status', 'confirmed')
    remaining = Math.max(0, data.capacity - (count || 0))
  }

  // Registration window state — saves the public form a round-trip.
  const now = Date.now()
  const opensAt = data.registration_opens_at ? Date.parse(data.registration_opens_at) : null
  const closesAt = data.registration_closes_at ? Date.parse(data.registration_closes_at) : null
  let registration_state = 'open'
  if (opensAt && now < opensAt) registration_state = 'not_yet_open'
  else if (closesAt && now > closesAt) registration_state = 'closed'
  else if (remaining === 0) registration_state = 'full'

  return NextResponse.json({
    success: true,
    data: { ...data, remaining_capacity: remaining, registration_state },
  })
}
