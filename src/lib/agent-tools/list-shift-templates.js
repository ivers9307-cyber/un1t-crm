// MCP.1 — `list_shift_templates`: the studio's active shift templates, so
// `create_shift` has a template id to name.

import { z } from 'zod'
import { defineTool } from './registry.js'
import { isManagerAt } from '@/lib/mcp/context'

const MAX_ROWS = 50

export default defineTool({
  name: 'list_shift_templates',
  title: 'Shift templates',
  description: 'The studio\'s active shift templates (id, name, default start and end, role label). For managers. '
    + 'Use an id from here with create_shift.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
  }),
  gate: (user, studioId) => isManagerAt(user, studioId),
  run: async (_input, ctx) => {
    const { db, studio } = ctx
    const { data, error } = await db.from('shift_templates')
      .select('id, name, start_time, end_time, role_label')
      .eq('location_id', studio.id)
      .eq('active', true)
      .order('display_order')
      .limit(MAX_ROWS + 1)
    if (error) throw new Error(`Failed to load shift templates: ${error.message}`)
    const rows = data || []
    return { studio: { id: studio.id, name: studio.name }, templates: rows.slice(0, MAX_ROWS), capped: rows.length > MAX_ROWS }
  },
})
