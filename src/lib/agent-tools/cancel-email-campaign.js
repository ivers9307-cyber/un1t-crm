// MCPEMAIL.1 — `cancel_email_campaign`: stop a scheduled, queued or sending
// email campaign. Uses the CRM's own stop rules (campaign-release.js).

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool, ToolRefusal } from './registry.js'
import { stopCampaign } from '@/lib/campaign-release'
import { emailGate, loadCampaignAtStudio } from './_email-campaign.js'

export default defineTool({
  name: 'cancel_email_campaign',
  title: 'Cancel email campaign',
  description: 'Stops an email campaign: a scheduled one goes back to draft, a queued or sending one is asked to '
    + 'stop (emails already sent cannot be recalled). Anything else is refused. '
    + 'This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    campaign_id: uuidLike.describe('The campaign id (see list_email_campaigns).'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, studio } = ctx
    // Only a campaign loaded at THIS studio is ever handed to stopCampaign.
    const campaign = await loadCampaignAtStudio(db, studio, input.campaign_id)
    const result = await stopCampaign(db, campaign)
    if (result.ok) return { outcome: result.outcome, status: result.status }
    if (result.code === 'not_stoppable') throw new ToolRefusal('conflict', result.message)
    throw new Error(`Failed to stop the campaign: ${result.message}`)
  },
})
