// MCP.1 — `staff_cost_report`: hours, hourly rate and cost per person over a
// period. The one tool that returns pay, so it is for the roles that may see
// rate reports in the app (RATE_REPORT_VIEWER_ROLES: owner, manager, master;
// not a head coach).

import { z } from 'zod'
import { defineTool } from './registry.js'
import { rangeFields, checkRange } from './_dates.js'
import { roleAt } from '@/lib/mcp/context'
import { RATE_REPORT_VIEWER_ROLES } from '@/lib/report-access'
import { staffCostReport } from './_staff-report.js'

export default defineTool({
  name: 'staff_cost_report',
  title: 'Staff cost report',
  description: 'Staff cost at a studio over a period of at most 366 days: hours, hourly rate and cost per person '
    + '(EUR), highest cost first, with the total. Shows pay rates, so it is for owners and managers only. '
    + 'Capped at 50 people (capped is true when there are more; total_cost still covers everyone).',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    ...rangeFields,
  }).superRefine(checkRange({ maxDays: 366, what: 'A report' })),
  gate: (user, studioId) => RATE_REPORT_VIEWER_ROLES.includes(roleAt(user, studioId)),
  run: async (input, ctx) => {
    const { db, studio } = ctx
    const report = await staffCostReport(db, { locationId: studio.id, start: input.start, end: input.end })
    return { studio: { id: studio.id, name: studio.name }, ...report }
  },
})
