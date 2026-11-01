// MCP.1 — `get_shifts`: who is on shift at the studio between two dates.
// Same read and same draft rule as the coach's own schedule
// (GET /api/schedule/shifts): a manager sees draft rosters, everyone else
// published shifts only, slimmed (fetchApiShiftRows judges each row by the
// viewer's role at that row's studio).

import { z } from 'zod'
import { defineTool } from './registry.js'
import { rangeFields, checkRange } from './_dates.js'
import { isManagerAt } from '@/lib/mcp/context'
import { fetchApiShiftRows } from '@/lib/roster-read'
import { eachReportDay } from '@/lib/report-period'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'

const MAX_ROWS = 50
const MAX_DAYS = 31
const hhmm = (t) => (t ? String(t).slice(0, 5) : null)

export default defineTool({
  name: 'get_shifts',
  title: 'Shifts',
  description: 'Shifts at a studio between two dates (at most 31 days), with each person\'s effective start and end '
    + '(wall-clock times in the studio\'s time zone, which is named in the result). Managers also see draft rosters; '
    + 'everyone else sees published shifts only. unpublished_days lists days no published roster covers: '
    + 'a day listed there is "not published yet", not "nobody is working". Lists are capped at 50 rows; '
    + 'ask for a shorter range when capped is true.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    ...rangeFields,
  }).superRefine(checkRange({ maxDays: MAX_DAYS, what: 'A shift lookup' })),
  gate: () => true,
  run: async (input, ctx) => {
    const { db, user, studio, zone } = ctx
    const manager = isManagerAt(user, studio.id)
    const viewer = { id: user.id, isManagerAt: (locationId) => isManagerAt(user, locationId) }

    const { rows, error, capped } = await fetchApiShiftRows(db, {
      locationIds: [studio.id], startDate: input.start, endDate: input.end, publishedOnly: !manager, viewer,
    })
    // A failed read is a failed call, never an empty week read out as "nobody is on".
    if (error) throw new Error(`Failed to load shifts: ${error.message || error}`)

    // Days no published roster covers (a roster's period is whatever was
    // requested, so a week can be half published).
    const { data: published, error: rostersError } = await db.from('rosters')
      .select('period_start, period_end')
      .eq('location_id', studio.id)
      .eq('status', 'published')
      .lte('period_start', input.end)
      .gte('period_end', input.start)
    if (rostersError) throw new Error(`Failed to load rosters: ${rostersError.message}`)
    const unpublishedDays = []
    for (const day of eachReportDay(input.start, input.end)) {
      if (!(published || []).some((r) => r.period_start <= day && r.period_end >= day)) unpublishedDays.push(day)
    }

    return {
      studio: { id: studio.id, name: studio.name },
      zone,
      shifts: rows.slice(0, MAX_ROWS).map((s) => ({
        id: s.id,
        date: s.shift_date,
        start: hhmm(effectiveShiftStart(s)),
        end: hhmm(effectiveShiftEnd(s)),
        profile_id: s.profile_id,
        name: s.profiles?.full_name ?? null,
        template: s.shift_templates?.name ?? null,
        // A manager sees draft rosters, so says which rows are live; everyone
        // else only ever sees published shifts.
        ...(manager ? { published: Boolean(s.published) } : {}),
      })),
      unpublished_days: unpublishedDays,
      capped: Boolean(capped) || rows.length > MAX_ROWS,
    }
  },
})
