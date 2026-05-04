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
      id, name, slug, description, race_date,
      registration_opens_at, registration_closes_at,
      allowed_team_sizes, location_id,
      waves:race_waves ( id, start_time, capacity, label, display_order ),
      locations:location_id ( id, name, address, timezone )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Per-wave remaining capacity (mig 083). One COUNT per wave is fine
  // for v1 (waves per race < ~10 in any realistic event); a single
  // grouped query would shave a roundtrip but the polling cadence
  // here is once-per-page-load so it doesn't matter.
  const waves = (data.waves || []).slice().sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0) || (a.start_time || '').localeCompare(b.start_time || '')
  )
  const wavesWithCounts = []
  for (const w of waves) {
    let remaining = null
    if (w.capacity != null) {
      const { count } = await db
        .from('race_registrations')
        .select('*', { count: 'exact', head: true })
        .eq('race_event_id', data.id)
        .eq('wave_id', w.id)
        .eq('status', 'confirmed')
      remaining = Math.max(0, w.capacity - (count || 0))
    }
    wavesWithCounts.push({ ...w, remaining_capacity: remaining })
  }

  // Registration window state — saves the public form a round-trip.
  const now = Date.now()
  const opensAt = data.registration_opens_at ? Date.parse(data.registration_opens_at) : null
  const closesAt = data.registration_closes_at ? Date.parse(data.registration_closes_at) : null
  // Race is "full" when every capped wave has zero remaining. Waves
  // with NULL capacity (unlimited) keep the race open.
  const allWavesFull = wavesWithCounts.length > 0 && wavesWithCounts.every(
    (w) => w.capacity != null && w.remaining_capacity === 0
  )
  let registration_state = 'open'
  if (opensAt && now < opensAt) registration_state = 'not_yet_open'
  else if (closesAt && now > closesAt) registration_state = 'closed'
  else if (allWavesFull) registration_state = 'full'

  return NextResponse.json({
    success: true,
    data: { ...data, waves: wavesWithCounts, registration_state },
  })
}
