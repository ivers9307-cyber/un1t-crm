// POST /api/attendance/geofence-checkin
//
// GEO-ATT.4 — the mobile app's geofence ENTER handler calls this.
// Matches the arrival to a shift in a ±4h window and stamps it with a
// race-guarded UPDATE … WHERE start_time_override IS NULL, writing an
// audit row with source='geofence' (mig 463). The caller can only stamp
// THEMSELVES (profile from the JWT) at a location they're assigned to,
// so unknown_user / wrong_location can't occur here.
//
// Outcomes returned (data.match_outcome):
//   matched | already_stamped | no_shift_in_window   → audit row written
//   duplicate (10-min flap dedup) | geofence_exempt
//     | impersonation_ignored                        → NO audit row

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { geofenceFromLocationSettings, geofenceIsConfigured } from '@/lib/geofence-attendance'
import { resolveScheduledAt, matchArrivalToShift, arrivalToTimeOnly } from '@/lib/staff-attendance'

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
  if (linkErr) return NextResponse.json({ success: false, error: linkErr.message }, { status: 400 })
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
    .select('id')
    .eq('profile_id', user.id)
    .eq('location_id', location.id)
    .eq('source', 'geofence')
    .gte('event_at', sinceIso)
    .limit(1)
  if (dupErr) return NextResponse.json({ success: false, error: dupErr.message }, { status: 400 })
  if (recent && recent.length > 0) {
    return NextResponse.json({ success: true, data: { match_outcome: 'duplicate' } })
  }

  // ── Shift match + race-guarded stamp (mirrors unifi-access) ──────
  let matchOutcome = 'no_shift_in_window'
  let matchedAssignmentId = null

  const dayBefore = new Date(eventAt.getTime() - 24 * 3600_000).toISOString().slice(0, 10)
  const dayAfter  = new Date(eventAt.getTime() + 24 * 3600_000).toISOString().slice(0, 10)

  // DB errors in the match/stamp path return 503 (transient) BEFORE the
  // audit insert — a dedup-blocking row must never be written for a ping
  // we didn't actually process, so the phone's queued retry can succeed.
  const { data: rows, error: shiftErr } = await db
    .from('shift_assignments')
    .select(`
      id, profile_id, status, start_time_override,
      block:shift_blocks!inner ( id, location_id, block_date, start_time, end_time )
    `)
    .eq('profile_id', user.id)
    .is('start_time_override', null)
    .neq('status', 'cancelled')
    .gte('block.block_date', dayBefore)
    .lte('block.block_date', dayAfter)
    .eq('block.location_id', location.id)
  // transient:true is the client's retry marker — api() passes the parsed
  // envelope through verbatim, so flushQueue can keep the ping queued
  // without sniffing the (arbitrary) DB error string.
  if (shiftErr) return NextResponse.json({ success: false, error: shiftErr.message, transient: true }, { status: 503 })

  const shifts = (rows || [])
    .map((r) => {
      if (!r.block) return null
      const scheduledAt    = resolveScheduledAt(r.block.block_date, r.block.start_time, locationTz)
      const scheduledEndAt = resolveScheduledAt(r.block.block_date, r.block.end_time,   locationTz)
      return scheduledAt ? { id: r.id, scheduledAt, scheduledEndAt } : null
    })
    .filter(Boolean)

  const best = matchArrivalToShift(eventAt, shifts)
  if (best) {
    const stamp = arrivalToTimeOnly(eventAt, locationTz)
    const { error: updErr } = await db
      .from('shift_assignments')
      .update({ start_time_override: stamp })
      .eq('id', best.shift.id)
      .is('start_time_override', null)
    if (updErr) return NextResponse.json({ success: false, error: updErr.message, transient: true }, { status: 503 })
    // Post-update verify is best-effort — a read-back failure only
    // risks the matched/already_stamped label, not the stamp itself.
    const { data: post } = await db
      .from('shift_assignments')
      .select('start_time_override')
      .eq('id', best.shift.id)
      .single()
    if (post && post.start_time_override === stamp) {
      matchedAssignmentId = best.shift.id
      matchOutcome = 'matched'
    } else {
      matchedAssignmentId = best.shift.id
      matchOutcome = 'already_stamped'
    }
  }

  const { error: insErr } = await db
    .from('staff_attendance_events')
    .insert({
      profile_id: user.id,
      location_id: location.id,
      source: 'geofence',
      event_at: eventAt.toISOString(),
      matched_assignment_id: matchedAssignmentId,
      match_outcome: matchOutcome,
      payload: {
        device_name: body.device_name || null,
        client_entered_at: body.entered_at,
        clamped,
      },
    })
  // 23505 = the mig 465 partial unique index rejected a same-minute
  // duplicate. That's the concurrency backstop for the SELECT→INSERT
  // race in the dedup above (two OS fires ~40ms apart both cleared the
  // 10-min check — observed live 2026-07-31). Terminal, NOT transient:
  // the first request already logged and stamped, so the client must
  // dequeue rather than retry forever.
  if (insErr?.code === '23505') {
    return NextResponse.json({ success: true, data: { match_outcome: 'duplicate' } })
  }
  // Any other audit-insert failure is transient (same 503 contract): the
  // retry is safe — the stamp (if any) already landed, so the replay
  // resolves as already_stamped, and dedup only keys on inserted rows.
  if (insErr) return NextResponse.json({ success: false, error: insErr.message, transient: true }, { status: 503 })

  return NextResponse.json({ success: true, data: { match_outcome: matchOutcome } })
}
