// MCPEMAIL.2 — `create_email_draft_from_template`: a marketing email campaign
// DRAFT whose body is a saved template. The body is edited in the CRM only. It
// can never be sent from here.

import { z } from 'zod'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { unknownMergeTags } from '@/lib/agent-email-blocks'
import { loadMarketingTemplate } from '@/lib/email-templates-for-agents'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { defineTool, ToolRefusal } from './registry.js'
import { emailGate, resolveAudienceFilter } from './_email-campaign.js'
import { ResendSchema, resendColumns, checkReplyTo, sendsAs, throwWriteError } from './_email-draft.js'

function refuseUnknownTags(where, text) {
  const unknown = unknownMergeTags(text)
  if (unknown.length) {
    throw new ToolRefusal('invalid_input', `${where} has {{${unknown[0]}}}, which a campaign cannot fill `
      + '(or it has spaces inside the braces). Only merge tags like {{first_name}} are supported; pick another template or edit this one in the CRM.')
  }
}

export default defineTool({
  name: 'create_email_draft_from_template',
  title: 'Create email draft from template',
  description: 'Creates a marketing email campaign as a draft from a saved template (see list_email_templates). '
    + 'The template\'s body is kept as is and can only be edited in the CRM; you set the name, subject (defaults to the template\'s), '
    + 'preview text, from name, reply-to, an audience (segment_id or filter) and an optional resend. '
    + 'A template with placeholders a campaign cannot fill is refused. It never sends: a person releases it from a signed-in page. '
    + 'This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    template_id: uuidLike.describe('A template id from list_email_templates.'),
    name: z.string().trim().min(1).max(200).describe('Internal campaign name.'),
    subject: z.string().trim().min(1).max(200).optional().describe('The subject line; omit to use the template\'s.'),
    preview_text: z.string().trim().max(500).optional().describe('Inbox preview text.'),
    from_name: z.string().trim().max(100).optional().describe('Sender display name.'),
    reply_to: z.string().trim().email().max(254).optional().describe('Reply-to address on the studio\'s verified domain.'),
    segment_id: uuidLike.optional().describe('A saved segment at this studio, instead of filter.'),
    filter: audienceFilterSchema.describe('An inline audience filter, instead of segment_id.'),
    resend: ResendSchema.describe('Optional: after_hours (1 to 168) and an optional subject. Resends to people who did not open it. A person approves it with the send.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const template = await loadMarketingTemplate(db, studio.id, input.template_id)
    if (!template) throw new ToolRefusal('not_found', 'No such email template at this studio. Check list_email_templates.')
    if (!String(template.html_content ?? '').trim()) throw new ToolRefusal('invalid_input', 'This template has no body.')
    const subject = input.subject ?? template.subject
    if (!subject) throw new ToolRefusal('invalid_input', 'This template has no subject; pass one.')
    refuseUnknownTags('The template body', template.html_content)
    refuseUnknownTags(input.subject ? 'The subject' : 'The template subject', subject)

    if (input.reply_to) await checkReplyTo(db, studio, input.reply_to)
    const wantsAudience = input.segment_id != null || input.filter != null
    const audienceFilter = wantsAudience ? await resolveAudienceFilter(db, studio, user, input) : null
    const resend = resendColumns(input.resend)

    const row = {
      location_id: studio.id,
      status: 'draft',
      created_by: user.id,
      created_via: 'mcp',
      postmark_stream: 'broadcast',
      name: input.name,
      subject,
      preview_text: input.preview_text ?? null,
      from_name: input.from_name ?? null,
      reply_to: input.reply_to ?? null,
      audience_filter: audienceFilter,
      template_id: template.id,
      html_content: template.html_content,
      design_json: template.design_json,
      agent_blocks: null,
      ...resend,
    }
    const { data, error } = await db.from('campaigns').insert(row).select('id, name, status').single()
    if (error || !data) throwWriteError(error, 'create the draft')

    const audience = audienceFilter ? await emailAudienceCounts(db, { filter: audienceFilter, locationId: studio.id }) : null
    return {
      campaign: { id: data.id, name: data.name, status: data.status },
      sends_as: await sendsAs(db, studio),
      audience,
      body_editable_from_claude: false,
    }
  },
})
