// MCPEMAIL.2 — `update_email_segment`: rename or re-filter a saved segment at
// the studio. Unlike the CRM route, Claude refuses ANY edit to a segment a
// sequence starts from (a draft sequence included): changing the filter would
// silently change who that sequence emails.

import { z } from 'zod'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { canWriteSegmentsAt, countSequencesUsingSegment } from '@/lib/segment-access'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { stripUnsetFilterRows } from '@/lib/audience-filter'
import { defineTool, ToolRefusal } from './registry.js'
import { emailGate, cleanSegmentFilter } from './_email-campaign.js'

export default defineTool({
  name: 'update_email_segment',
  title: 'Update email segment',
  description: 'Renames a saved segment at the studio, changes its description or replaces its filter (give the segment id '
    + 'and at least one field). Refused when a sequence starts from the segment: edit those in the CRM. '
    + 'Returns the segment and how many people an email to it would reach. This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    segment_id: uuidLike.describe('The segment to change (from list_email_segments).'),
    name: z.string().trim().min(1).max(120).optional().describe('New name, unique at the studio.'),
    description: z.string().trim().max(2000).optional().describe('New description.'),
    filter: audienceFilterSchema.describe('A replacement audience filter.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId) && canWriteSegmentsAt(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, studio } = ctx
    if (input.name === undefined && input.description === undefined && input.filter == null) {
      throw new ToolRefusal('invalid_input', 'Give at least one field to change besides segment_id.')
    }
    const filter = input.filter != null ? cleanSegmentFilter(input.filter) : undefined

    const { data: segment, error: readErr } = await db
      .from('contact_segments')
      .select('id, location_id, name, filter')
      .eq('id', input.segment_id)
      .eq('location_id', studio.id)
      .maybeSingle()
    if (readErr) throw new Error(`Failed to load segment: ${readErr.message}`)
    if (!segment) throw new ToolRefusal('not_found', 'Segment not found.')

    // A failed read is never "no sequences": proceeding could re-aim a live sequence.
    const used = await countSequencesUsingSegment(db, segment)
    if (used.error || used.count == null) {
      throw new Error(`Failed to check which sequences use this segment: ${used.error?.message || 'no count'}`)
    }
    if (used.count > 0) {
      throw new ToolRefusal('conflict', 'A sequence starts from this segment. Edit it in the CRM.')
    }

    const updates = { updated_at: new Date().toISOString() }
    if (input.name !== undefined) updates.name = input.name
    if (input.description !== undefined) updates.description = input.description
    if (filter !== undefined) updates.filter = filter

    const { data, error } = await db
      .from('contact_segments')
      .update(updates)
      .eq('id', segment.id)
      .eq('location_id', studio.id)
      .select('id, name')
      .single()
    if (error) {
      if (error.code === '23505' || /duplicate key|unique constraint/i.test(error.message || '')) {
        throw new ToolRefusal('conflict', 'A segment with this name already exists.')
      }
      throw new Error(`Failed to update the segment: ${error.message}`)
    }
    if (!data) throw new Error('Failed to update the segment: no row returned')
    // The edit has landed: a count that cannot be made (say an old stored filter
    // that no longer validates) must not report the call as failed.
    let count = null
    try {
      const saved = stripUnsetFilterRows(filter ?? segment.filter)
      count = (await emailAudienceCounts(db, { filter: saved, locationId: studio.id })).eligible
    } catch {
      count = null
    }
    return { segment: { id: data.id, name: data.name }, count }
  },
})
