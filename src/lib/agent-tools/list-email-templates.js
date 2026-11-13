// MCPEMAIL.2 — `list_email_templates`: the studio's saved marketing email designs.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool } from './registry.js'
import { listMarketingTemplates } from '@/lib/email-templates-for-agents'
import { emailGate, LIST_CAP } from './_email-campaign.js'

export default defineTool({
  name: 'list_email_templates',
  title: 'Email templates',
  description: 'Lists the studio\'s saved marketing email templates (id, name, subject, category, description), up to 50. '
    + 'Booking and event confirmations and reminders are never listed. Pass an id to create_email_draft_from_template.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  run: async (_input, ctx) => {
    const { db, studio } = ctx
    const templates = await listMarketingTemplates(db, studio.id)
    return { templates: templates.slice(0, LIST_CAP), capped: templates.length >= LIST_CAP }
  },
})
