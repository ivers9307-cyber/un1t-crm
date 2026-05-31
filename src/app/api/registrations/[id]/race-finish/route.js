// POST /api/registrations/[id]/race-finish
//
// Stamps race_finished_at = NOW() if started but not finished.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { triggerSequencesForRaceFinished } from '@/lib/sequences'
import { emitEvent, applyTagRules, EVENT_TYPES } from '@/lib/contact-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
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
  const guard = assertLocationAccess(user, reg.race_events?.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

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
