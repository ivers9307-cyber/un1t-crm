// MCP.1 — `staff_hours_report`: scheduled hours per person over a period.
// Hours only; pay figures live in `staff_cost_report` and nowhere else.

import { z } from 'zod'
import { defineTool } from './registry.js'
import { rangeFields, checkRange } from './_dates.js'
import { isManagerAt } from '@/lib/mcp/context'
import { staffHoursReport } from './_staff-report.js'

export default defineTool({
  name: 'staff_hours_report',
  title: 'Staff hours report',
  description: 'Scheduled hours per staff member at a studio over a period of at most 366 days, highest first, with the '
    + 'total. Hours are the effective shift hours (a coach\'s changed times count). No pay figures. For managers. '
    + 'Capped at 50 people (capped is true when there are more; total_hours still covers everyone).',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    ...rangeFields,
  }).superRefine(checkRange({ maxDays: 366, what: 'A report' })),
  gate: (user, studioId) => isManagerAt(user, studioId),
  run: async (input, ctx) => {
    const { db, studio } = ctx
    const report = await staffHoursReport(db, { locationId: studio.id, start: input.start, end: input.end })
    return { studio: { id: studio.id, name: studio.name }, ...report }
  },
})
