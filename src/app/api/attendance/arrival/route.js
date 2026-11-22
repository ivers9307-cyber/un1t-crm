// PUT /api/attendance/arrival
//
// ARRIVALFIX.1 — a manager enters (or corrects) a coach's arrival by hand,
// from the attendance report (/schedule/attendance). Until now only the
// phone's geofence check-in wrote shift_assignments.arrived_at, so a dead
// phone left a permanent no-show nobody could fix.
//
// ACCESS: the attendance_reports permission at the ACTIVE studio (the same
// gate as GET /api/attendance), and the assignment's shift must be at that
// studio: anything else is a 404, so an id cannot be probed.
//
// Body: { assignment_id, time: 'HH:MM' }  (the studio's wall clock, on the
//        shift's own date)
//
// The rules (future refused; a manual stamp and, since ARRIVALFIX.2, a phone
// (geofence) stamp both correctable) are src/lib/manual-arrival.js. The write
// is compare-and-set on the stamp that was read (time and source), so an
// arrival landing or changing in between is never overwritten. A
// staff_attendance_events row (source 'manual') records who entered it and
// the stamp it replaced; that row is bookkeeping, so its failure is logged
// and the arrival still stands.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { uuidLike } from '@/lib/schemas'
import { zoneOfLocation } from '@/lib/location-time'
import { logError } from '@/lib/log'
import { decideManualArrival, MANUAL_ARRIVAL_SOURCE } from '@/lib/manual-arrival'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const ManualArrivalSchema = z.object({
  assignment_id: uuidLike,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)'),
})

const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const FAILED = () => NextResponse.json({ success: false, error: 'Could not save the arrival. Try again.' }, { status: 500 })

export const PUT = withAuth(
  { permission: 'attendance_reports', location: true, schema: ManualArrivalSchema },
  async ({ db, user, locationId, input }) => {
    const { assignment_id, time } = input

    const { data: assignment, error: readError } = await db
      .from('shift_assignments')
      .select('id, profile_id, status, arrived_at, arrival_source, block:shift_blocks!inner ( id, location_id, block_date )')
      .eq('id', assignment_id)
      .eq('block.location_id', locationId)
      .maybeSingle()                       // primary key; 0 rows = not found here
    if (readError) {
      logError('attendance', 'manual arrival read failed', { assignment_id, locationId, error: readError.message })
      return FAILED()
    }
    if (!assignment || assignment.block?.location_id !== locationId) return NOT_FOUND()

    const { data: location, error: locationError } = await db
      .from('locations')
      .select('id, timezone')
      .eq('id', locationId)
      .maybeSingle()
    if (locationError || !location) {
      logError('attendance', 'manual arrival location read failed', { locationId, error: locationError?.message || 'missing' })
      return FAILED()
    }

    const decision = decideManualArrival({ assignment, time, zone: zoneOfLocation(location) })
    if (!decision.ok) return NextResponse.json({ success: false, error: decision.error }, { status: decision.status })

    // Compare-and-set on what was read: unstamped stays unstamped until now,
    // a stamp (manual or phone) is still the same stamp from the same source.
    let write = db
      .from('shift_assignments')
      .update({ arrived_at: decision.arrivedAt, arrival_source: MANUAL_ARRIVAL_SOURCE })
      .eq('id', assignment.id)
      .neq('status', 'cancelled')
    if (assignment.arrived_at) {
      write = write.eq('arrived_at', assignment.arrived_at)
      write = assignment.arrival_source
        ? write.eq('arrival_source', assignment.arrival_source)
        : write.is('arrival_source', null)
    } else {
      write = write.is('arrived_at', null)
    }
    const { data: updated, error: writeError } = await write.select('id')
    if (writeError) {
      logError('attendance', 'manual arrival write failed', { assignment_id, error: writeError.message })
      return FAILED()
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'This arrival changed while you were editing it. Refresh and try again.',
      }, { status: 409 })
    }

    const { error: eventError } = await db.from('staff_attendance_events').insert({
      profile_id: assignment.profile_id,
      location_id: locationId,
      source: MANUAL_ARRIVAL_SOURCE,
      event_at: decision.arrivedAt,
      matched_assignment_id: assignment.id,
      match_outcome: 'matched',
      payload: {
        entered_by: user.id,
        previous_arrived_at: assignment.arrived_at || null,
        previous_source: assignment.arrival_source || null,
      },
    })
    if (eventError) {
      logError('attendance', 'manual arrival audit row failed', { assignment_id, error: eventError.message })
    }

    return NextResponse.json({
      success: true,
      data: { assignment_id: assignment.id, arrived_at: decision.arrivedAt, arrival_source: MANUAL_ARRIVAL_SOURCE },
    })
  },
)
