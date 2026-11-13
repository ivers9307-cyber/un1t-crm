// MCPEMAIL.2 — `create_email_segment`: save a reusable audience filter at the
// studio, the same write POST /api/contacts/segments makes.

import { z } from 'zod'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { canWriteSegmentsAt } from '@/lib/segment-access'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { defineTool, ToolRefusal } from './registry.js'
import { emailGate, cleanSegmentFilter } from './_email-campaign.js'

export default defineTool({
  name: 'create_email_segment',
  title: 'Create email segment',
  description: 'Saves a reusable audience filter (a segment) at the studio, so drafts and the CRM can use it by name. '
    + 'The filter needs at least one row. Returns the segment and how many people an email to it would reach. '
    + 'This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    name: z.string().trim().min(1).max(120).describe('Segment name, unique at the studio.'),
    description: z.string().trim().max(2000).optional().describe('What the segment is for.'),
    filter: audienceFilterSchema.describe('The audience filter.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId) && canWriteSegmentsAt(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const filter = cleanSegmentFilter(input.filter)
    const { data, error } = await db
      .from('contact_segments')
      .insert({
        location_id: studio.id,
        name: input.name,
        description: input.description ?? null,
        filter,
        created_by: user.id,
      })
      .select('id, name')
      .single()
    if (error) {
      if (error.code === '23505' || /duplicate key|unique constraint/i.test(error.message || '')) {
        throw new ToolRefusal('conflict', 'A segment with this name already exists.')
      }
      throw new Error(`Failed to create the segment: ${error.message}`)
    }
    if (!data) throw new Error('Failed to create the segment: no row returned')
    const { eligible } = await emailAudienceCounts(db, { filter, locationId: studio.id })
    return { segment: { id: data.id, name: data.name }, count: eligible }
  },
})
