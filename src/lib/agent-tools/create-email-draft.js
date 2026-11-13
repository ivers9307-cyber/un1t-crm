// MCPEMAIL.1 — `create_email_draft`: a new marketing email campaign, as a
// DRAFT. It can never be sent from here: only the signed-in confirm page
// releases a campaign.

import { z } from 'zod'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { defineTool } from './registry.js'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { emailGate, resolveAudienceFilter } from './_email-campaign.js'
import { EmailBlocksSchema, ResendSchema, buildBody, resendColumns, checkReplyTo, sendsAs, throwWriteError } from './_email-draft.js'

export default defineTool({
  name: 'create_email_draft',
  title: 'Create email draft',
  description: 'Creates a marketing email campaign as a draft at the studio: name, subject, optional preview text, '
    + 'from name and reply-to (on the studio\'s verified domain), the body as blocks (heading, paragraph, list, '
    + 'button, image from list_email_images, divider) and optionally an audience (segment_id or filter; check it '
    + 'with count_email_audience) and a resend to people who did not open it. It never sends: a person releases it from a signed-in page. '
    + 'This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    name: z.string().trim().min(1).max(200).describe('Internal campaign name.'),
    subject: z.string().trim().min(1).max(200).describe('The email subject line.'),
    preview_text: z.string().trim().max(500).optional().describe('Inbox preview text.'),
    from_name: z.string().trim().max(100).optional().describe('Sender display name.'),
    reply_to: z.string().trim().email().max(254).optional().describe('Reply-to address on the studio\'s verified domain.'),
    blocks: EmailBlocksSchema.describe('The email body, 1 to 60 blocks.'),
    segment_id: uuidLike.optional().describe('A saved segment at this studio, instead of filter.'),
    filter: audienceFilterSchema.describe('An inline audience filter, instead of segment_id.'),
    resend: ResendSchema.describe('Optional: after_hours (1 to 168) and an optional subject. Resends to people who did not open it. A person approves it with the send.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    if (input.reply_to) await checkReplyTo(db, studio, input.reply_to)
    const wantsAudience = input.segment_id != null || input.filter != null
    const audienceFilter = wantsAudience ? await resolveAudienceFilter(db, studio, user, input) : null
    const resend = resendColumns(input.resend)
    const body = await buildBody(db, user, studio, input.blocks)

    const row = {
      location_id: studio.id,
      status: 'draft',
      created_by: user.id,
      created_via: 'mcp',
      postmark_stream: 'broadcast',
      name: input.name,
      subject: input.subject,
      preview_text: input.preview_text ?? null,
      from_name: input.from_name ?? null,
      reply_to: input.reply_to ?? null,
      audience_filter: audienceFilter,
      ...body,
      ...resend,
    }
    const { data, error } = await db.from('campaigns').insert(row).select('id, name, status').single()
    if (error || !data) throwWriteError(error, 'create the draft')

    const audience = audienceFilter ? await emailAudienceCounts(db, { filter: audienceFilter, locationId: studio.id }) : null
    return {
      campaign: { id: data.id, name: data.name, status: data.status },
      sends_as: await sendsAs(db, studio),
      audience,
    }
  },
})
