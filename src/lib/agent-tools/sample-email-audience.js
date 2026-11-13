// MCPEMAIL.2 — `sample_email_audience`: up to 50 masked people an audience
// would reach by email, so the person can sanity-check it before approving.

import { z } from 'zod'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { defineTool, ToolRefusal } from './registry.js'
import { stripUnsetFilterRows } from '@/lib/audience-filter'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { emailAudienceSample } from '@/lib/email-audience-sample'
import { emailGate, resolveAudienceFilter, loadCampaignAtStudio, hasFilterRows } from './_email-campaign.js'

export default defineTool({
  name: 'sample_email_audience',
  title: 'Sample email audience',
  description: 'Shows up to 50 of the people an audience would reach by email, each as first name, masked email and '
    + 'pipeline stage, plus how many would be sent to. Give exactly one of segment_id, filter ({ logic, filters: '
    + '[{ field, op, value }] }, at least one row) or campaign_id (that campaign\'s saved audience).',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    segment_id: uuidLike.optional().describe('A saved segment at this studio (see list_email_segments).'),
    filter: audienceFilterSchema.describe('An inline audience filter, instead of segment_id.'),
    campaign_id: uuidLike.optional().describe('A campaign at this studio; its saved audience is sampled.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const given = [input.segment_id, input.filter, input.campaign_id].filter((v) => v != null).length
    if (given !== 1) throw new ToolRefusal('invalid_input', 'Give exactly one of segment_id, filter and campaign_id.')

    let filter
    if (input.campaign_id != null) {
      const campaign = await loadCampaignAtStudio(db, studio, input.campaign_id)
      filter = stripUnsetFilterRows(campaign.audience_filter)
      if (!hasFilterRows(filter)) {
        throw new ToolRefusal('invalid_input', 'The audience filter needs at least one filter row.')
      }
    } else {
      filter = await resolveAudienceFilter(db, studio, user, input)
    }

    const sample = await emailAudienceSample(db, { filter, locationId: studio.id })
    const counts = await emailAudienceCounts(db, { filter, locationId: studio.id })
    return {
      sample,
      count: counts.eligible,
      note: 'A sample of up to 50 of the people who would receive it.',
    }
  },
})
