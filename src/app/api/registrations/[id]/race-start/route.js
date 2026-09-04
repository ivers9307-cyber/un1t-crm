// POST /api/registrations/[id]/race-start
//
// Race-day operator tap. Stamps race_started_at = NOW() if not
// already started. Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
  }

  // RACEDAY.1 — optional "offsite override" note on the request body.
  //
  // The mobile race board renders read-only when the phone's own position
  // says the operator is not physically at the studio; a deliberate
  // "I'm at the gym — enable controls" tap unlocks it and posts
  // { override: true } here so the choice is visible after the fact.
  //
  // 🔴 THIS IS NOT A GATE, and the next reader will assume it is one. It is a
  // note about how the operator got to the button — never an input to whether
  // the write is allowed. This route runs no position check of its own, so a
  // client that omits the flag (the web panel posts no body at all) or that
  // sends override:false while genuinely offsite gets byte-identical
  // behaviour: same guards, same status codes, same write. Do not grow a
  // rejection path, a new status code or a position check out of it.
  //
  // Parsing is deliberately total. These routes have always been called with
  // no body and no Content-Type, so a missing, empty or malformed body must
  // behave exactly as it did before this flag existed rather than becoming a
  // 400 that breaks every existing caller. That is also why there is no Zod
  // schema here — validateBody would reject the empty request the web panel
  // still sends.
  let offsiteOverride = false
  try {
    const body = await request.json()
    offsiteOverride = body?.override === true
  } catch {
    // No body, or a body that isn't JSON — the historical call shape.
    // Leave the flag false; the request proceeds unchanged.
  }

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`
      id, status, race_started_at, race_finished_at,
      race_events ( id, location_id, kind )
    `)
    .eq('id', params.id)
    .single()
  if (lookupErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, reg.race_events?.location_id)
  if (guard) return guard

  // Mig 122 (E7): race-day timing only applies to kind='race'.
  // A workshop/seminar/etc. registration has no "started" semantics
  // — return 409 to make the operator UI failure mode obvious if
  // it ever fires (the control panel page is also gated, so this is
  // belt-and-braces).
  if (reg.race_events?.kind && reg.race_events.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `Race-day timing doesn't apply to ${reg.race_events.kind} events.`,
    }, { status: 409 })
  }

  if (reg.status !== 'confirmed') {
    return NextResponse.json({
      success: false,
      error: `Cannot start race for a ${reg.status} registration.`,
    }, { status: 409 })
  }
  if (reg.race_started_at) {
    return NextResponse.json({
      success: true,
      no_op: true,
      race_started_at: reg.race_started_at,
    })
  }

  const startedAt = new Date().toISOString()
  const { error: upErr } = await db
    .from('race_registrations')
    .update({ race_started_at: startedAt })
    .eq('id', reg.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  // RACEDAY.1 — record that this stamp came from an offsite override.
  // There is no audit TABLE to write to: these routes record no actor at all
  // today, not even who started a team. That is a real pre-existing gap, but
  // closing it needs a migration and is deliberately out of scope — a
  // structured log line (matchable by Sentinel on module + msg) is the whole
  // ask here. Emitted only after the update actually landed, so the
  // already-started no-op return above and a failed write both stay silent.
  if (offsiteOverride) {
    logWarn('race-control', 'offsite override', {
      actor: user.id,
      registration_id: reg.id,
      race_event_id: reg.race_events?.id,
      action: 'race-start',
    })
  }

  return NextResponse.json({ success: true, race_started_at: startedAt })
}
