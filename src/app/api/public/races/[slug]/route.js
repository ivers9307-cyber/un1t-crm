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
      member_pricing_enabled, member_fee_cents, non_member_fee_cents,
      members_only, payment_currency,
      waves:race_waves ( id, start_time, capacity, label, display_order ),
      locations:location_id ( id, name, address, timezone )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Per-wave fullness (mig 083; capacity numbers hidden from public).
  // Public callers only need to know whether each wave is bookable —
  // exposing exact "X of Y spots remaining" is operator-only data
  // (visible inside the CRM /races index). Strip raw capacity +
  // remaining numbers from the response shape; surface a boolean
  // is_full instead. One COUNT per wave is fine for v1 (waves per
  // race < ~10 in any realistic event).
  const wavesIn = (data.waves || []).slice().sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0) || (a.start_time || '').localeCompare(b.start_time || '')
  )
  const publicWaves = []
  for (const w of wavesIn) {
    let isFull = false
    if (w.capacity != null) {
      const { count } = await db
        .from('race_registrations')
        .select('*', { count: 'exact', head: true })
        .eq('race_event_id', data.id)
        .eq('wave_id', w.id)
        .eq('status', 'confirmed')
      isFull = (count || 0) >= w.capacity
    }
    // Strip capacity from the per-wave object — only id, start_time,
    // label, display_order, is_full leave the building.
    publicWaves.push({
      id: w.id,
      start_time: w.start_time,
      label: w.label,
      display_order: w.display_order,
      is_full: isFull,
    })
  }

  // Registration window state — saves the public form a round-trip.
  const now = Date.now()
  const opensAt = data.registration_opens_at ? Date.parse(data.registration_opens_at) : null
  const closesAt = data.registration_closes_at ? Date.parse(data.registration_closes_at) : null
  // Race is "full" when every wave with a cap is full AND there are
  // no uncapped waves to absorb. (An unlimited wave keeps the race
  // open even if every other wave is full.)
  const hasUncapped = wavesIn.some((w) => w.capacity == null)
  const allCappedFull = publicWaves.length > 0 && !hasUncapped && publicWaves.every((w) => w.is_full)
  let registration_state = 'open'
  if (opensAt && now < opensAt) registration_state = 'not_yet_open'
  else if (closesAt && now > closesAt) registration_state = 'closed'
  else if (allCappedFull) registration_state = 'full'

  // Strip the race-level deprecated capacity from the public response
  // too (defensive; the field is supposed to be deprecated but it
  // could still be on existing rows).
  // eslint-disable-next-line no-unused-vars
  const { capacity: _omit, ...racePublic } = data
  return NextResponse.json({
    success: true,
    data: { ...racePublic, waves: publicWaves, registration_state },
  })
}
