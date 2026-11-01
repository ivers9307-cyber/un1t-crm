// MCP.1 — `get_appointments`: the studio's appointment bookings (the Calendly
// hub's `bookings`, not Glofox class bookings) between two dates, at most 31
// days. Same permission as the Bookings list (`bookings`). `booking_date`,
// `start_time` and `end_time` are wall-clock in the studio's zone, so the day
// range is compared as dates and the times are returned as `HH:MM`, never
// parsed as instants.

import { z } from 'zod'
import { defineTool } from './registry.js'
import { rangeFields, checkRange } from './_dates.js'
import { hasPermissionForLocation } from '@/lib/permissions'

const MAX_ROWS = 50
const MAX_DAYS = 31
const hhmm = (t) => (t ? String(t).slice(0, 5) : null)

export default defineTool({
  name: 'get_appointments',
  title: 'Appointments',
  description: 'Appointment bookings at a studio between two dates (at most 31 days): date, start and end '
    + '(wall-clock times in the studio\'s time zone, named in the result), status, type and the contact. '
    + 'These are appointments, not class bookings (see get_classes). Capped at 50 (capped is true when there '
    + 'are more; ask for a shorter range). Needs the Bookings permission.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    ...rangeFields,
  }).superRefine(checkRange({ maxDays: MAX_DAYS, what: 'An appointment lookup' })),
  gate: (user, studioId) => hasPermissionForLocation(user, studioId, 'bookings'),
  run: async (input, ctx) => {
    const { db, studio, zone } = ctx
    const { data, error } = await db.from('bookings')
      .select('id, booking_date, start_time, end_time, status, contact_id, event_types(name, slug), contacts!contact_id(name)')
      .eq('location_id', studio.id)
      .gte('booking_date', input.start)
      .lte('booking_date', input.end)
      .order('booking_date', { ascending: true })
      .order('start_time', { ascending: true })
      .order('id')
      .limit(MAX_ROWS + 1)
    // A failed read is a failed call, never an empty diary.
    if (error) throw new Error(`Failed to load appointments: ${error.message}`)
    const rows = data || []

    return {
      studio: { id: studio.id, name: studio.name },
      zone,
      appointments: rows.slice(0, MAX_ROWS).map((b) => ({
        id: b.id,
        date: b.booking_date,
        start: hhmm(b.start_time),
        end: hhmm(b.end_time),
        status: b.status,
        type: b.event_types?.name ?? null,
        contact: b.contact_id ? { id: b.contact_id, name: b.contacts?.name ?? null } : null,
      })),
      capped: rows.length > MAX_ROWS,
    }
  },
})
