// MCP.1 — `list_staff`: the active people who work at the studio, so a
// follow-up call has their ids. Exactly four fields per person. No email,
// phone or pay: those columns are not even selected.

import { z } from 'zod'
import { defineTool } from './registry.js'
import { isManagerAt } from '@/lib/mcp/context'

const MAX_ROWS = 50

export default defineTool({
  name: 'list_staff',
  title: 'Staff',
  description: 'Active staff at a studio: id, name, role there and employment type. For managers. '
    + 'Capped at 50 people (capped is true when there are more).',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
  }),
  gate: (user, studioId) => isManagerAt(user, studioId),
  run: async (_input, ctx) => {
    const { db, studio } = ctx

    const { data: links, error: linksError } = await db.from('profile_locations')
      .select('profile_id, role')
      .eq('location_id', studio.id)
    if (linksError) throw new Error(`Failed to load staff: ${linksError.message}`)
    const roleOf = new Map((links || []).map((l) => [l.profile_id, l.role]))
    if (roleOf.size === 0) return { studio: { id: studio.id, name: studio.name }, staff: [], capped: false }

    const { data: people, error } = await db.from('profiles')
      .select('id, full_name, employment_type, active')
      .in('id', [...roleOf.keys()])
      .eq('active', true)
      .order('full_name')
    if (error) throw new Error(`Failed to load staff: ${error.message}`)

    const staff = (people || []).map((p) => ({
      id: p.id,
      name: p.full_name,
      role: roleOf.get(p.id) ?? null,
      employment_type: p.employment_type ?? null,
    }))
    return { studio: { id: studio.id, name: studio.name }, staff: staff.slice(0, MAX_ROWS), capped: staff.length > MAX_ROWS }
  },
})
