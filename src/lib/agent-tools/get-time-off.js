// MCP.1 — `get_time_off`: leave requests overlapping a date range at the
// studio. A manager sees everyone's; anyone else sees their own only (the
// in-app assistant's rule). Pay is never involved.

import { z } from 'zod'
import { defineTool } from './registry.js'
import { rangeFields, checkRange } from './_dates.js'
import { isManagerAt } from '@/lib/mcp/context'

const MAX_ROWS = 50

export default defineTool({
  name: 'get_time_off',
  title: 'Time off',
  description: 'Time-off requests (holiday, sick and so on, with status) that overlap a date range at a studio, at most '
    + '366 days. Managers see everyone; anyone else sees only their own requests. Lists are capped at 50 rows; '
    + 'ask for a shorter range when capped is true.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    ...rangeFields,
  }).superRefine(checkRange({ maxDays: 366, what: 'A time-off lookup' })),
  gate: () => true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx

    // Filters first, then order and limit; the studio filter is visibly part of the chain.
    let query = db.from('time_off_requests')
      .select('id, profile_id, type, status, start_date, end_date, reason')
      .eq('location_id', studio.id)
      .lte('start_date', input.end)
      .gte('end_date', input.start)
    if (!isManagerAt(user, studio.id)) query = query.eq('profile_id', user.id)
    const { data, error } = await query
      .order('start_date')
      .limit(MAX_ROWS + 1)
    // A failed read is a failed call, never "nobody is off".
    if (error) throw new Error(`Failed to load time off: ${error.message}`)

    const rows = data || []
    const page = rows.slice(0, MAX_ROWS)
    const names = new Map()
    const ids = [...new Set(page.map((r) => r.profile_id))]
    if (ids.length > 0) {
      const { data: people, error: peopleError } = await db.from('profiles')
        .select('id, full_name')
        .in('id', ids)
      if (peopleError) throw new Error(`Failed to load names: ${peopleError.message}`)
      for (const p of people || []) names.set(p.id, p.full_name)
    }

    return {
      studio: { id: studio.id, name: studio.name },
      time_off: page.map((r) => ({
        id: r.id,
        profile_id: r.profile_id,
        name: names.get(r.profile_id) ?? null,
        type: r.type,
        status: r.status,
        start: r.start_date,
        end: r.end_date,
        reason: r.reason ?? null,
      })),
      capped: rows.length > MAX_ROWS,
    }
  },
})
