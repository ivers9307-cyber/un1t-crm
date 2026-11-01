// MCP.1 — `get_classes`: the class timetable at a studio for a day or up to 14
// days, with how many are booked and waitlisted on each. Open to anyone with the
// AI Assistant at the studio (the timetable is public on the booking pages);
// who is IN a class is `get_class_roster`, behind Contacts.
//
// Days are the studio's calendar days: `YYYY-MM-DD` becomes a `starts_at`
// window from local midnight of the first day to local midnight of the day
// after the last (zonedWallClockToInstant, never a `Z` string). Counts come
// from `class_bookings` for the listed events at this studio. Glofox spells a
// waitlisted booking WAITING and a cancelled one CANCELLED (upper case, see
// mapBookingToRosterRow); a row with no status counts as booked, as the roster
// readers treat it.

import { z } from 'zod'
import { defineTool, ToolRefusal } from './registry.js'
import { checkRange } from './_dates.js'
import { reportPeriodError } from '@/lib/report-period'
import { addDaysISO, zonedWallClockToInstant } from '@/lib/location-time'

const MAX_ROWS = 50
const MAX_DAYS = 14
// PostgREST returns at most 1,000 rows a select, so the counts page through.
const PAGE = 1000

const WAITLISTED = new Set(['WAITING', 'WAITLIST', 'WAITLISTED', 'WAIT_LIST'])
const upper = (s) => String(s ?? '').trim().toUpperCase()

export default defineTool({
  name: 'get_classes',
  title: 'Classes',
  description: 'The class timetable at a studio: one day (date, default today) or up to 14 days (start and end), '
    + 'on the studio\'s calendar. Each class has its start and end instants (UTC), name, trainer, capacity, '
    + 'booked and waitlisted counts and the platform that runs it. Lists are capped at 50 classes (capped is true '
    + 'when there are more; ask for a shorter range). Names of who is booked are in get_class_roster.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    date: z.string().optional().describe('One day, YYYY-MM-DD, on the studio\'s calendar. Default: today.'),
    start: z.string().optional().describe('First day of a range, YYYY-MM-DD (give end too; at most 14 days).'),
    end: z.string().optional().describe('Last day (inclusive) of a range, YYYY-MM-DD.'),
  }).superRefine((value, ctx) => {
    if (value.date && (value.start || value.end)) {
      ctx.addIssue({ code: 'custom', message: 'Give either date, or start and end, not both' })
    } else if (value.date) {
      const message = reportPeriodError(value.date, value.date, { startName: 'date', endName: 'date', maxDays: MAX_DAYS })
      if (message) ctx.addIssue({ code: 'custom', message })
    } else if (Boolean(value.start) !== Boolean(value.end)) {
      ctx.addIssue({ code: 'custom', message: 'Give both start and end, or just date' })
    } else if (value.start) {
      checkRange({ maxDays: MAX_DAYS, what: 'A class lookup' })(value, ctx)
    }
  }),
  gate: () => true,
  run: async (input, ctx) => {
    const { db, studio, zone, today } = ctx
    const first = input.date || input.start || today
    const last = input.date || input.end || first

    const fromMs = zonedWallClockToInstant(first, '00:00', zone)
    const toMs = zonedWallClockToInstant(addDaysISO(last, 1), '00:00', zone)
    if (fromMs == null || toMs == null) throw new ToolRefusal('invalid_input', 'start and end must be real dates, YYYY-MM-DD')
    const from = new Date(fromMs).toISOString()
    const to = new Date(toMs).toISOString()

    const { data, error } = await db.from('class_occurrences')
      .select('id, glofox_event_id, name, program, starts_at, ends_at, capacity, instructor, source_platform')
      .eq('location_id', studio.id)
      // The sync stamps cancelled_at on a class that vanished from the platform or went inactive.
      .is('cancelled_at', null)
      .gte('starts_at', from)
      .lt('starts_at', to)
      .order('starts_at', { ascending: true })
      .order('id')
      .limit(MAX_ROWS + 1)
    // A failed read is a failed call, never an empty timetable read out as "no classes".
    if (error) throw new Error(`Failed to load classes: ${error.message}`)
    const rows = data || []
    const listed = rows.slice(0, MAX_ROWS)

    const booked = new Map()
    const waitlisted = new Map()
    const eventIds = [...new Set(listed.map((c) => c.glofox_event_id).filter(Boolean))]
    if (eventIds.length > 0) {
      for (let offset = 0; ; offset += PAGE) {
        const { data: page, error: bookingsError } = await db.from('class_bookings')
          .select('glofox_event_id, status')
          .eq('location_id', studio.id)
          .in('glofox_event_id', eventIds)
          .order('id')
          .range(offset, offset + PAGE - 1)
        if (bookingsError) throw new Error(`Failed to load class bookings: ${bookingsError.message}`)
        for (const b of page || []) {
          const status = upper(b.status)
          if (status === 'CANCELLED') continue
          const into = WAITLISTED.has(status) ? waitlisted : booked
          into.set(b.glofox_event_id, (into.get(b.glofox_event_id) || 0) + 1)
        }
        if ((page || []).length < PAGE) break
      }
    }

    return {
      studio: { id: studio.id, name: studio.name },
      zone,
      from: first,
      to: last,
      classes: listed.map((c) => ({
        id: c.id,
        starts_at: c.starts_at,
        ends_at: c.ends_at,
        name: c.name,
        trainer: c.instructor,
        capacity: c.capacity,
        booked: booked.get(c.glofox_event_id) || 0,
        waitlisted: waitlisted.get(c.glofox_event_id) || 0,
        platform: c.source_platform,
      })),
      capped: rows.length > MAX_ROWS,
    }
  },
})
