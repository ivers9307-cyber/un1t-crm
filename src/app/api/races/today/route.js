// GET /api/races/today
//
// RACE-TAB.1 — "is there a race running here today?", the one question the
// mobile bottom bar needs answered to decide whether to surface a contextual
// Race tab (mobile/app/(staff)/(tabs)/_layout.jsx).
//
// Why a dedicated route rather than filtering GET /api/races client-side:
//   - /api/races is the AUTHORING list. It returns every race the location
//     has ever run, each with its full waves + registrations embed — a
//     payload measured in hundreds of KB on a studio with history, fetched
//     to answer a yes/no question. This route answers it in one row per
//     race, no embeds beyond a wave start time.
//   - The "today" boundary is Europe/Dublin, and it is computed HERE, on the
//     server, via todayIsoDublin(). A phone's clock and timezone belong to
//     whoever is holding it — an operator whose device is still on holiday
//     time, or a tablet that never left UTC, must not get a different answer
//     about the studio's day than the person standing next to them. Mobile
//     carries no timezone maths for this at all.
//   - /api/races is additionally MANAGER_ROLES-gated because it is the
//     authoring surface. The control board and the race-* action routes need
//     only the `races` feature, and this route gates the tab that leads to
//     the board — so it matches the BOARD's gate, not the authoring one.
//
// Returns an ARRAY, empty when there is no race today. Two races in one day
// at one location is entirely plausible (a morning and an afternoon heat
// block run as separate events), so the caller renders a picker rather than
// assuming a single answer.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { todayIsoDublin } from '@shared/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * First wave start for a race, as the operator would read it.
 *
 * `race_events.start_time` still exists on disk but is DEPRECATED (mig 083 —
 * "app code no longer reads it"); the per-wave `race_waves.start_time` rows
 * are the source of truth, and a race created since mig 083 leaves the race
 * level NULL. So the race's start time is the earliest of its waves. TIME
 * comes back as 'HH:MM:SS'; lexical order is chronological for a fixed-width
 * 24h clock, so a plain string compare is correct here and needs no parsing.
 *
 * @param {Array<{start_time?: string|null}>|null|undefined} waves
 * @returns {string|null} 'HH:MM:SS', or null for a race with no timed wave
 */
function firstWaveStart(waves) {
  let earliest = null
  for (const w of waves || []) {
    const t = w?.start_time
    if (!t) continue
    if (earliest === null || t < earliest) earliest = t
  }
  return earliest
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  // The mobile client always sends the studio it is asking about, but fall
  // back to the caller's active location so a bare hit from the web/n8n side
  // still means something. No location at all (a master with no active
  // studio selected) is not an error — there is simply no race to report.
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId) return NextResponse.json({ success: true, data: [] })

  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  // Second gate, scoped to the TARGET studio rather than the active one.
  // hasPermission above resolves against user.activeLocation, so a
  // multi-studio operator whose active context lags the studio they asked
  // about would otherwise be judged at the wrong one — races can be enabled
  // at Stillorgan and off at Hatch for the same person. Same message as the
  // gate above so the two are indistinguishable to a client.
  if (!hasPermissionForLocation(user, locationId, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('race_events')
    .select('id, name, slug, race_date, waves:race_waves ( start_time )')
    .eq('location_id', locationId)
    // Mig 122: race_events is the multi-kind events table. Only `race` rows
    // have a race-day control board, so a workshop today must not put a Race
    // tab on anyone's bar. NOT NULL with DEFAULT 'race', so .eq is exact.
    .eq('kind', 'race')
    // `active` is the operator's own on/off switch; `status` (mig 388) is the
    // host self-serve review lattice. A draft or pending_review race has no
    // registrations to control, so neither belongs on race day.
    .eq('active', true)
    .eq('status', 'published')
    .eq('race_date', todayIsoDublin())

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const races = (data || [])
    .map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      race_date: r.race_date,
      start_time: firstWaveStart(r.waves),
    }))
    // Running order, so a two-race day reads as a timeline. A race with no
    // timed wave sorts last rather than first — an untimed row is the
    // half-configured one, not the one that goes off at midnight.
    .sort((a, b) =>
      (a.start_time || '99:99:99').localeCompare(b.start_time || '99:99:99') ||
      (a.name || '').localeCompare(b.name || ''))

  return NextResponse.json({ success: true, data: races })
}
