// GET /api/public/races/[slug]/display
//
// Public — no auth. Powers the TV-friendly race-day display at
// /race/[slug]/display. Returns enough state to render two screens
// (active on course + completed for the day) plus a server clock so
// the page can compute live elapsed times without trusting the
// browser clock.
//
// Data exposed is intentionally narrow: team name, wave label,
// start/finish ISO timestamps. Member emails / IDs / phones / etc.
// are NOT included. Anything more would leak through the public URL.
//
// Refresh policy: force-dynamic + revalidate=0. The page polls this
// every 2s during a race.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(_request, { params }) {
  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, name, slug, race_date, location_id,
      waves:race_waves ( id, start_time, label, display_order )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (raceErr || !race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Pull every confirmed registration for this race. We filter to
  // started/finished on the page so a single shape covers both
  // screens. Ignore cancelled / refunded — they shouldn't appear on
  // the spectator board.
  const { data: registrations, error: regErr } = await db
    .from('race_registrations')
    .select(`
      id, status, race_started_at, race_finished_at, wave_id,
      teams ( id, name, size )
    `)
    .eq('race_event_id', race.id)
    .in('status', ['confirmed', 'completed'])
    .order('race_started_at', { ascending: true, nullsFirst: false })

  if (regErr) {
    return NextResponse.json({ success: false, error: regErr.message }, { status: 500 })
  }

  // Strip down to the smallest possible per-team shape. No member
  // data, no contact_id, no email. The TV doesn't need it.
  const wavesById = new Map((race.waves || []).map((w) => [w.id, w]))
  const trim = (r) => {
    const wave = r.wave_id ? wavesById.get(r.wave_id) : null
    return {
      id: r.id,
      team_name: r.teams?.name || 'Unknown team',
      team_size: r.teams?.size ?? null,
      wave_label: wave?.label || null,
      wave_start_time: wave?.start_time || null,
      race_started_at: r.race_started_at,
      race_finished_at: r.race_finished_at,
    }
  }

  const active = []
  const completed = []
  for (const r of (registrations || [])) {
    if (r.race_finished_at) completed.push(trim(r))
    else if (r.race_started_at) active.push(trim(r))
  }

  // Sort waves for the page footer.
  const waves = (race.waves || []).slice().sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0) || (a.start_time || '').localeCompare(b.start_time || ''),
  )

  return NextResponse.json({
    success: true,
    data: {
      race: {
        id: race.id,
        name: race.name,
        slug: race.slug,
        race_date: race.race_date,
      },
      waves: waves.map((w) => ({ id: w.id, label: w.label, start_time: w.start_time })),
      active,
      completed,
      server_now: new Date().toISOString(),
    },
  })
}
