// MCPEMAIL.1 — `get_email_campaign`: one campaign at this studio. Aggregate
// figures only; never a recipient list, the stored HTML or the raw filter.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool } from './registry.js'
import { InvalidAudienceFilterError, stripUnsetFilterRows } from '@/lib/audience-filter'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { pendingApproval, agentReleaseBlocker, resendSummary } from '@/lib/campaign-approval'
import { describeFromAddress } from '@/lib/from-address'
import { campaignDisplayStats, loadCampaignRecipientStats } from '@/lib/campaign-display-stats'
import { emailGate, loadCampaignAtStudio, hasFilterRows, htmlSha256, RESULT_STATUSES } from './_email-campaign.js'

export default defineTool({
  name: 'get_email_campaign',
  title: 'Email campaign',
  description: 'Returns one email campaign: its settings, the body blocks (when an agent wrote it) and whether the body '
    + 'was edited in the CRM since, the audience head-count and any waiting send approval for a campaign not yet sent, '
    + 'release_blocker (a sentence, when the campaign can only be sent from the CRM: tell the person before testing), '
    + 'the resend to non-openers (and its child once it has started), and the results once it has gone out. Use it to review a campaign before changing or releasing it.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    campaign_id: uuidLike.describe('The campaign id (see list_email_campaigns).'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  run: async (input, ctx) => {
    const { db, studio, nowMs } = ctx
    const campaign = await loadCampaignAtStudio(db, studio, input.campaign_id)
    const hasResults = RESULT_STATUSES.includes(campaign.status)
    const agent = campaign.agent_blocks ?? null

    let results = null
    let audience = null
    let approval = null
    if (hasResults) {
      // Loaded for the studio-scoped campaign's id only.
      const stats = await loadCampaignRecipientStats(db, [campaign.id])
      results = campaignDisplayStats(campaign, stats)
    } else {
      if (hasFilterRows(campaign.audience_filter)) {
        try {
          audience = await emailAudienceCounts(db, { filter: stripUnsetFilterRows(campaign.audience_filter), locationId: studio.id })
        } catch (e) {
          if (!(e instanceof InvalidAudienceFilterError)) throw e
        }
      }
      approval = (await pendingApproval(db, campaign.id, nowMs)) ?? null
    }

    const summary = resendSummary(campaign)
    const resend = summary
      ? { after_hours: campaign.resend_wait_hours, subject: campaign.resend_subject || null, summary }
      : null
    // The resend child exists only once the spawner has fired; read at THIS studio.
    let resendChild
    if (resend && campaign.status === 'sent') {
      const { data: child, error: childError } = await db
        .from('campaigns')
        .select('id, status, total_sent')
        .eq('parent_campaign_id', campaign.id)
        .eq('location_id', studio.id)
        .limit(1)
        .maybeSingle()
      if (childError) throw new Error(`Failed to load the resend: ${childError.message}`)
      if (child) resendChild = { id: child.id, status: child.status, sent: child.total_sent ?? 0 }
    }

    const { sends_as } = await describeFromAddress(db, studio.id, campaign.from_email ?? null)
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        subject: campaign.subject,
        preview_text: campaign.preview_text ?? null,
        from_name: campaign.from_name ?? null,
        reply_to: campaign.reply_to ?? null,
        status: campaign.status,
        scheduled_at: campaign.scheduled_at ?? null,
        last_error: campaign.last_error ?? null,
        created_via: campaign.created_via,
        sends_as,
      },
      blocks: agent?.blocks ?? null,
      body_edited_in_crm: agent != null && htmlSha256(campaign.html_content ?? '') !== agent.html_sha256,
      audience,
      approval_waiting: approval,
      // Why send_email_for_approval would refuse this campaign (null when it would not).
      release_blocker: hasResults ? null : agentReleaseBlocker(campaign),
      resend,
      ...(resendChild ? { resend_child: resendChild } : {}),
      results,
    }
  },
})
