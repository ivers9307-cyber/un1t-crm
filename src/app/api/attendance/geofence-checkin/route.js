// POST /api/attendance/geofence-checkin
//
// GEO-ATT.4 — the mobile app's geofence ENTER handler calls this.
// ARRIVAL.1 — records ARRIVAL on shift_assignments.arrived_at. It never
// writes start_time_override: that column is the manager-set paid window
// (mig 099, D3) and every hours/cost reader bills it. Order is decide →
// claim the audit row (the mig 465 unique index stops a duplicate ping
// here) → stamp arrived_at WHERE arrived_at IS NULL. The caller can only
// stamp THEMSELVES (profile from the JWT) at a location they're assigned
// to, so unknown_user / wrong_location can't occur here.
//
// Outcomes returned (data.match_outcome):
//   matched | already_stamped | no_shift_in_window   → audit row written
//   duplicate (10-min flap dedup) | geofence_exempt
//     | impersonation_ignored                        → NO audit row
//
// A re-entry ping (the coach is still on/near a shift they already arrived
// for) is audited as already_stamped with payload.reentry=true and stamps
// nothing — the attendance report infers that earlier arrival onto the next
// shift. A ping that lands inside the dedup window of a recent claim whose
// stamp never landed (process killed, the response lost, or the
// release-on-error delete below itself failing) completes that claimed
// assignment's stamp on this retry instead of answering 'duplicate' forever
// and losing the arrival behind the dedup window.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { geofenceFromLocationSettings, geofenceIsConfigured } from '@/lib/geofence-attendance'
import { resolveScheduledAt, decideGeofenceStamp } from '@/lib/staff-attendance'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CLOCK_SKEW_MS = 5 * 60_000   // trust client entered_at within ±5 min
const DEDUP_WINDOW_MS = 10 * 60_000 // one geofence event per profile+location per 10 min

const GeofenceCheckinSchema = z.object({
  location_id: uuidLike,
  entered_at: z.string().datetime({ offset: true }),
  device_name: z.string().max(80).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // GEO-ATT.10b — defense-in-depth: a master viewing-as a staff member
  // resolves to the TARGET profile here (user.impersonatingFrom carries
  // the real master, src/lib/auth.js mig 035), so a geofence ping from
  // the master's phone would stamp the TARGET's attendance. The mobile
  // client already refuses to register regions mid-impersonation; this
  // catches any queued ping that slips through. Success-shaped so the
  // client dequeues; response-only outcome, never inserted.
  if (user.impersonatingFrom) {
    return NextResponse.json({ success: true, data: { match_outcome: 'impersonation_ignored' } })
  }

  const validation = await validateBody(request, GeofenceCheckinSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()

  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, timezone, settings')
    .eq('id', body.location_id)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const geo = geofenceFromLocationSettings(location.settings)
  if (!geofenceIsConfigured(geo)) {
    // 404 not 403 — don't advertise which locations have the feature.
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const locationTz = location.timezone || 'Europe/Dublin'

  const { data: link, error: linkErr } = await db
    .from('profile_locations')
    .select('geofence_exempt')
    .eq('profile_id', user.id)
    .eq('location_id', location.id)
    .maybeSingle()
  if (linkErr) return NextResponse.json({ success: false, error: linkErr.message, transient: true }, { status: 503 })
  if (!link) return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  if (link.geofence_exempt) {
    return NextResponse.json({ success: true, data: { match_outcome: 'geofence_exempt' } })
  }

  // Clamp the client timestamp — phone clocks and queued retries are
  // untrusted; anything outside ±5 min becomes "now".
  const nowMs = Date.now()
  const clientMs = new Date(body.entered_at).getTime()
  const clamped = !Number.isFinite(clientMs) || Math.abs(nowMs - clientMs) > CLOCK_SKEW_MS
  const eventAt = clamped ? new Date(nowMs) : new Date(clientMs)

  // Region-flap dedup: one geofence event per profile+location per window.
  const sinceIso = new Date(eventAt.getTime() - DEDUP_WINDOW_MS).toISOString()
  const { data: recent, error: dupErr } = await db
    .from('staff_attendance_events')
    .select('id, match_outcome, matched_assignment_id, event_at')
    .eq('profile_id', user.id)
    .eq('location_id', location.id)
    .eq('source', 'geofence')
    .gte('event_at', sinceIso)
    .limit(1)
  if (dupErr) return NextResponse.json({ success: false, error: dupErr.message, transient: true }, { status: 503 })
  if (recent && recent.length > 0) {
    const [priorEvent] = recent
    // Lost-arrival recovery: the earlier request already decided AND claimed,
    // but its stamp never landed. Retry it here against the CLAIMED
    // assignment, using the earlier event's timestamp — this is the only
    // remaining chance for that arrival to land, since every later ping in
    // this window would otherwise just repeat 'duplicate'.
    if (priorEvent.match_outcome === 'matched' && priorEvent.matched_assignment_id) {
      const { error: recErr } = await db
        .from('shift_assignments')
        .update({ arrived_at: priorEvent.event_at, arrival_source: 'geofence' })
        .eq('id', priorEvent.matched_assignment_id)
        .is('arrived_at', null)
        .select('id')
      if (recErr) return NextResponse.json({ success: false, error: recErr.message, transient: true }, { status: 503 })
    }
    return NextResponse.json({ success: true, data: { match_outcome: 'duplicate' } })
  }

  // ── Decide, claim, stamp (ARRIVAL.1) ─────────────────────────────
  const dayBefore = new Date(eventAt.getTime() - 24 * 3600_000).toISOString().slice(0, 10)
  const dayAfter  = new Date(eventAt.getTime() + 24 * 3600_000).toISOString().slice(0, 10)

  // Every live shift for this coach here, INCLUDING ones that already have an
  // arrival. Filtering those out is what let a duplicate ping move on to the
  // coach's next shift. DB errors return 503 (transient) before any write.
  const { data: rows, error: shiftErr } = await db
    .from('shift_assignments')
    .select(`
      id, profile_id, status, arrived_at,
      block:shift_blocks!inner ( id, location_id, block_date, start_time, end_time )
    `)
    .eq('profile_id', user.id)
    .neq('status', 'cancelled')
    .gte('block.block_date', dayBefore)
    .lte('block.block_date', dayAfter)
    .eq('block.location_id', location.id)
  // transient:true is the client's retry marker — api() passes the parsed
  // envelope through verbatim.
  if (shiftErr) return NextResponse.json({ success: false, error: shiftErr.message, transient: true }, { status: 503 })

  const shifts = (rows || [])
    .map((r) => {
      if (!r.block) return null
      const scheduledAt    = resolveScheduledAt(r.block.block_date, r.block.start_time, locationTz)
      const scheduledEndAt = resolveScheduledAt(r.block.block_date, r.block.end_time,   locationTz)
      return scheduledAt
        ? { id: r.id, scheduledAt, scheduledEndAt, arrivedAt: r.arrived_at ? new Date(r.arrived_at) : null }
        : null
    })
    .filter(Boolean)

  const decision = decideGeofenceStamp(eventAt, shifts)
  const matchOutcome = decision.kind === 'stamp'
    ? 'matched'
    : decision.kind === 'none' ? 'no_shift_in_window' : 'already_stamped'

  // Claim first. The mig 465 partial unique index (profile, location, minute)
  // turns a concurrent duplicate into a 23505 HERE, before it can touch a shift.
  const { data: claim, error: insErr } = await db
    .from('staff_attendance_events')
    .insert({
      profile_id: user.id,
      location_id: location.id,
      source: 'geofence',
      event_at: eventAt.toISOString(),
      matched_assignment_id: decision.shift?.id ?? null,
      match_outcome: matchOutcome,
      payload: {
        device_name: body.device_name || null,
        client_entered_at: body.entered_at,
        clamped,
        ...(decision.kind === 'reentry' ? { reentry: true } : {}),
      },
    })
    .select('id')
    .single()
  // Terminal, NOT transient: the first request already claimed this minute, so
  // the client must dequeue rather than retry forever.
  if (insErr?.code === '23505') {
    return NextResponse.json({ success: true, data: { match_outcome: 'duplicate' } })
  }
  if (insErr || !claim) {
    return NextResponse.json({ success: false, error: insErr?.message || 'audit insert failed', transient: true }, { status: 503 })
  }

  if (decision.kind !== 'stamp') {
    return NextResponse.json({ success: true, data: { match_outcome: matchOutcome } })
  }

  const { data: stamped, error: updErr } = await db
    .from('shift_assignments')
    .update({ arrived_at: eventAt.toISOString(), arrival_source: 'geofence' })
    .eq('id', decision.shift.id)
    .is('arrived_at', null)
    .select('id')
  if (updErr) {
    // Release the claim: left in place, the 10-minute dedup above would answer
    // the phone's retry with 'duplicate' and the arrival would never land.
    const { error: relErr } = await db.from('staff_attendance_events').delete().eq('id', claim.id)
    if (relErr) {
      logWarn('geofence-checkin', 'stamp failed and the audit claim could not be released; the retry will read as duplicate', {
        eventId: claim.id, assignmentId: decision.shift.id, err: relErr.message,
      })
    }
    return NextResponse.json({ success: false, error: updErr.message, transient: true }, { status: 503 })
  }
  if (!stamped || stamped.length === 0) {
    // Another request stamped this shift between our read and our write.
    const { error: relabelErr } = await db
      .from('staff_attendance_events')
      .update({ match_outcome: 'already_stamped' })
      .eq('id', claim.id)
    if (relabelErr) {
      logWarn('geofence-checkin', 'lost stamp race; audit row still reads matched', { eventId: claim.id, err: relabelErr.message })
    }
    return NextResponse.json({ success: true, data: { match_outcome: 'already_stamped' } })
  }

  return NextResponse.json({ success: true, data: { match_outcome: 'matched' } })
}
