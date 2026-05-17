// GET /api/public/events/[slug]/display
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

export async function GET(_request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, name, slug, race_date, kind, location_id, tv_logos,
      waves:race_waves ( id, start_time, label, display_order )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (raceErr || !race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Mig 122 (E7): the TV display board renders live race timing
  // (started/finished elapsed clocks per team) — race-specific by
  // design. For non-race kinds there's nothing to display, so we
  // 404 rather than render an empty board. Public URL: a operator
  // who shared /event/<workshop-slug>/display by mistake gets a
  // clean error.
  if (race.kind && race.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `The TV display board is only available for race events (this is a ${race.kind}).`,
    }, { status: 404 })
  }

  // Pull every confirmed registration for this race. We filter to
  // started/finished on the page so a single shape covers both
  // screens. Ignore cancelled / refunded — they shouldn't appear on
  // the spectator board.
  //
  // team_members (mig 086) provides the per-team competitor names.
  // Selecting ONLY `name` here on purpose — email / contact_id /
  // member_contact_id must never reach the public spectator URL.
  const { data: registrations, error: regErr } = await db
    .from('race_registrations')
    .select(`
      id, status, race_started_at, race_finished_at, wave_id,
      teams ( id, name, size, members:team_members ( name ) ),
      penalties:race_penalties ( seconds )
    `)
    .eq('race_event_id', race.id)
    .in('status', ['confirmed', 'completed'])
    .order('race_started_at', { ascending: true, nullsFirst: false })

  if (regErr) {
    return NextResponse.json({ success: false, error: regErr.message }, { status: 500 })
  }

  // Strip down to the smallest possible per-team shape. Only the
  // member NAME goes out — no contact_id, no email, no membership
  // status. Trim + dedup names so the TV row stays tidy if the
  // signup form let someone retype the same person.
  const wavesById = new Map((race.waves || []).map((w) => [w.id, w]))
  const trim = (r) => {
    const wave = r.wave_id ? wavesById.get(r.wave_id) : null
    const seen = new Set()
    const member_names = []
    for (const m of (r.teams?.members || [])) {
      const n = (m?.name || '').trim()
      if (!n) continue
      const k = n.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      member_names.push(n)
    }
    // Mig 124: sum penalty seconds for this row so the public TV
    // shows adjusted times. Send only the total — individual
    // penalty reasons + applier ids are operator-only data and
    // must never leak through the public URL.
    let penalty_total_seconds = 0
    for (const p of (r.penalties || [])) {
      const n = Number(p?.seconds)
      if (Number.isFinite(n)) penalty_total_seconds += n
    }
    return {
      id: r.id,
      team_name: r.teams?.name || 'Unknown team',
      team_size: r.teams?.size ?? null,
      member_names,
      wave_label: wave?.label || null,
      wave_start_time: wave?.start_time || null,
      race_started_at: r.race_started_at,
      race_finished_at: r.race_finished_at,
      penalty_total_seconds,
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
        // Mig 092: array of public logo URLs to render in the
        // header. Filter to strings (defensive against bad data) +
        // cap at 3 so the page never renders more than its layout
        // accounts for.
        tv_logos: Array.isArray(race.tv_logos)
          ? race.tv_logos.filter((u) => typeof u === 'string' && u.length > 0).slice(0, 3)
          : [],
      },
      waves: waves.map((w) => ({ id: w.id, label: w.label, start_time: w.start_time })),
      active,
      completed,
      server_now: new Date().toISOString(),
    },
  })
}
