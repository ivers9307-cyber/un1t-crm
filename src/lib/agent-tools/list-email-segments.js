// MCPEMAIL.1 — `list_email_segments`: the studio's saved audience segments.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool } from './registry.js'
import { canReadSegmentsAt } from '@/lib/segment-access'
import { emailGate, LIST_CAP } from './_email-campaign.js'

export default defineTool({
  name: 'list_email_segments',
  title: 'Email segments',
  description: 'Lists the studio\'s saved contact segments (id, name, description), up to 50. '
    + 'Use it to find a segment_id to pass to count_email_audience or a campaign.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId) && canReadSegmentsAt(user, studioId),
  run: async (_input, ctx) => {
    const { db, studio } = ctx
    const { data, error } = await db
      .from('contact_segments')
      .select('id, name, description')
      .eq('location_id', studio.id)
      .order('name', { ascending: true })
      .order('id')
      .limit(LIST_CAP + 1)
    if (error) throw new Error(`Failed to load segments: ${error.message}`)
    const rows = data || []
    return {
      segments: rows.slice(0, LIST_CAP).map((s) => ({ id: s.id, name: s.name, description: s.description ?? null })),
      capped: rows.length > LIST_CAP,
    }
  },
})
