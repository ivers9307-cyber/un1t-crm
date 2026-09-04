// POST /api/registrations/[id]/race-finish
//
// Stamps race_finished_at = NOW() if started but not finished.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { triggerSequencesForRaceFinished } from '@/lib/sequences'
import { emitEvent, applyTagRules, EVENT_TYPES } from '@/lib/contact-events'
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

  // RACEDAY.1 — optional "offsite override" note on the request body. The
  // mobile race board renders read-only when the phone's position says the
  // operator isn't at the studio; an explicit "I'm at the gym — enable
  // controls" tap unlocks it and posts { override: true } so the choice is
  // visible after the fact.
  //
  // 🔴 NOT A GATE. It records how the operator got to the button and is never
  // an input to whether the write is allowed — no position check runs here,
  // and omitting the flag (the web panel posts no body at all) or sending
  // override:false while offsite behaves identically, down to the status
  // codes. Full rationale in ../race-start/route.js.
  //
  // The parse is total on purpose: these routes have always been called with
  // no body and no Content-Type, so a missing, empty or malformed body must
  // behave exactly as before rather than become a 400. No Zod schema for the
  // same reason — it would reject the empty request the web panel sends.
  let offsiteOverride = false
  try {
    const body = await request.json()
    offsiteOverride = body?.override === true
  } catch {
    // No body, or not JSON — the historical call shape. Flag stays false.
  }

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`
      id, race_started_at, race_finished_at,
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
  if (reg.race_events?.kind && reg.race_events.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `Race-day timing doesn't apply to ${reg.race_events.kind} events.`,
    }, { status: 409 })
  }

  if (!reg.race_started_at) {
    return NextResponse.json({
      success: false,
      error: 'Cannot finish a race that has not started.',
      code: 'not_started',
    }, { status: 409 })
  }
  if (reg.race_finished_at) {
    return NextResponse.json({
      success: true,
      no_op: true,
      race_finished_at: reg.race_finished_at,
    })
  }

  const finishedAt = new Date().toISOString()
  const { error: upErr } = await db
    .from('race_registrations')
    .update({ race_finished_at: finishedAt })
    .eq('id', reg.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  // RACEDAY.1 — record that this came from an offsite override. There is no
  // audit TABLE to write to: these routes record no actor at all today, not
  // even who started a team. That gap is real but needs a migration and is
  // deliberately out of scope — a structured log line is the whole ask.
  // Emitted only after the update landed, so the already-finished no-op
  // return above and a failed write both stay silent.
  if (offsiteOverride) {
    logWarn('race-control', 'offsite override', {
      actor: user.id,
      registration_id: reg.id,
      race_event_id: reg.race_events?.id,
      action: 'race-finish',
    })
  }

  // Emit race.finished events for every team member with a contact_id
  // + reapply tag rules + fire the race_finished sequence trigger.
  // Best-effort — the timing update is the authoritative signal.
  try {
    const { data: regFull } = await db
      .from('race_registrations')
      .select(`
        id, race_event_id,
        race:race_event_id ( id, location_id ),
        teams:team_id ( id, team_members ( contact_id, email ) )
      `)
      .eq('id', reg.id)
      .single()
    const locationId = regFull?.race?.location_id
    const members = regFull?.teams?.team_members || []
    for (const m of members) {
      if (!m.email) continue
      await emitEvent({
        db,
        eventType: EVENT_TYPES.RACE_FINISHED,
        contactEmail: m.email,
        contactId: m.contact_id || null,
        locationId,
        sourceType: 'race_registration',
        sourceId: reg.id,
        metadata: { race_event_id: regFull?.race_event_id || null },
      })
      if (m.contact_id) {
        await applyTagRules({ db, contactId: m.contact_id })
      }
    }
    await triggerSequencesForRaceFinished(reg.id)
  } catch (e) {
    console.warn(`[race-finish] events/triggers failed for ${reg.id}: ${e?.message || e}`)
  }

  return NextResponse.json({
    success: true,
    race_started_at: reg.race_started_at,
    race_finished_at: finishedAt,
  })
}
