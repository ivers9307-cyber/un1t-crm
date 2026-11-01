// MCP.1 — `get_class_roster`: who is booked into one class. Needs the Class
// roster permission at the studio the call resolves to AND Contacts at the
// class's own studio (a roster is member names), through the same readable
// studios the contact tools use (readableContactStudios: the resolved studio's
// organisation, MCP switched on, AI Assistant and Contacts both held).
//
// The service role has no RLS, so that list is the fence: the occurrence is
// read `.in('location_id', readable)`, and an occurrence at any other studio
// answers exactly like an unknown id (`not_found`), so an id cannot be probed.

import { z } from 'zod'
import { defineTool, ToolRefusal } from './registry.js'
import { readableContactStudios } from './_contact-scope.js'
import { hasPermissionForLocation } from '@/lib/permissions'

const MAX_ROWS = 50
const NOT_FOUND = 'No such class.'

export default defineTool({
  name: 'get_class_roster',
  title: 'Class roster',
  description: 'Who is booked into one class (the id comes from get_classes): each booking\'s contact id, name, '
    + 'status (BOOKED, WAITING for the waitlist, CANCELLED) and whether they attended. Needs the Class roster '
    + 'and Contacts permissions at the class\'s studio. Capped at 50 bookings (capped is true when there are more).',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    occurrence_id: z.string().uuid().describe('The class id from get_classes.'),
  }),
  gate: (user, studioId) => hasPermissionForLocation(user, studioId, 'class_roster'),
  run: async (input, ctx) => {
    const { db, user } = ctx
    // Contacts AND the class roster at the class's own studio.
    const readable = readableContactStudios(user, ctx)
      .filter((id) => hasPermissionForLocation(user, id, 'class_roster'))
    if (readable.length === 0) throw new ToolRefusal('not_found', NOT_FOUND)

    const { data: occurrence, error } = await db.from('class_occurrences')
      .select('id, location_id, glofox_event_id, name, starts_at')
      .eq('id', input.occurrence_id)
      .in('location_id', readable)
      // A class the sync marked cancelled is not on the timetable get_classes lists: not_found.
      .is('cancelled_at', null)
      .maybeSingle()
    if (error) throw new Error(`Failed to load the class: ${error.message}`)
    if (!occurrence) throw new ToolRefusal('not_found', NOT_FOUND)

    const { data, error: bookingsError } = await db.from('class_bookings')
      .select('contact_id, member_name, status, attended')
      .eq('location_id', occurrence.location_id)
      .eq('glofox_event_id', occurrence.glofox_event_id)
      .order('member_name', { ascending: true })
      .order('id')
      .limit(MAX_ROWS + 1)
    if (bookingsError) throw new Error(`Failed to load the roster: ${bookingsError.message}`)
    const rows = data || []

    return {
      class: { id: occurrence.id, name: occurrence.name, starts_at: occurrence.starts_at, studio_id: occurrence.location_id },
      roster: rows.slice(0, MAX_ROWS).map((b) => ({
        contact_id: b.contact_id ?? null,
        name: b.member_name ?? null,
        status: b.status ?? null,
        attended: b.attended === true,
      })),
      capped: rows.length > MAX_ROWS,
    }
  },
})
