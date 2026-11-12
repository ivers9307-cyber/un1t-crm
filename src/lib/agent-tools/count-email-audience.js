// MCPEMAIL.1 — `count_email_audience`: how many people a filter or saved
// segment would reach by email at this studio, using the send path's own rules.

import { z } from 'zod'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { defineTool } from './registry.js'
import { AUDIENCE_FIELDS } from '@/lib/audience-filter'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { emailGate, resolveAudienceFilter } from './_email-campaign.js'

const FIELD_LIST = Object.entries(AUDIENCE_FIELDS)
  .map(([key, cfg]) => `${key} (${(cfg.ops || []).join(', ')})`)
  .join('; ')

export default defineTool({
  name: 'count_email_audience',
  title: 'Count email audience',
  description: 'Counts who an audience would reach by email: matched (fit the filter), eligible (would actually be sent to) '
    + 'and why the rest are excluded. Give exactly one of segment_id or filter ({ logic: "and"|"or", filters: '
    + '[{ field, op, value }] }, at least one row). Fields and operators: ' + FIELD_LIST + '.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    segment_id: uuidLike.optional().describe('A saved segment at this studio (see list_email_segments).'),
    filter: audienceFilterSchema.describe('An inline audience filter, instead of segment_id.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const filter = await resolveAudienceFilter(db, studio, user, input)
    const counts = await emailAudienceCounts(db, { filter, locationId: studio.id })
    return {
      matched: counts.matched,
      eligible: counts.eligible,
      excluded: counts.excluded,
      note: 'The frequency cap is applied per person at send time, so the number actually sent can be lower than eligible.',
    }
  },
})
