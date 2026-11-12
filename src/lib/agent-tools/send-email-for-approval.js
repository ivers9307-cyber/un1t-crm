// MCPEMAIL.1 — `send_email_for_approval`: email the CALLER a faithful test of a
// campaign with a one-time approve link. Nothing here sends the campaign: the
// link opens a signed-in CRM page, and a press there is the only release. The
// link's token goes into the test email and nowhere else (not the result, not
// an error, not a log), so the agent can never approve its own work.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool, ToolRefusal } from './registry.js'
import { InvalidAudienceFilterError, stripUnsetFilterRows } from '@/lib/audience-filter'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { issueApproval, voidApprovals, agentReleaseBlocker } from '@/lib/campaign-approval'
import { releasePreflight } from '@/lib/campaign-release'
import { describeFromAddress, withRequestedFrom } from '@/lib/from-address'
import { resolveEmailSender } from '@/lib/tenant-email'
import { getLocationBranding } from '@/lib/location-branding'
import { fetchLocationEmailCopy } from '@/lib/campaign-web-view'
import { sendEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { maskEmail } from '@/lib/audience-preview'
import { formatInZone } from '@/lib/location-time'
import { buildCampaignTestEmail, parseSendAt } from '@/lib/campaign-test-email'
import { emailGate, loadCampaignAtStudio, hasFilterRows } from './_email-campaign.js'

const TESTABLE_STATUSES = ['draft', 'scheduled']
const AS_SOON_AS_APPROVED = 'as soon as approved'

function timingLabel(at, zone) {
  if (!at) return AS_SOON_AS_APPROVED
  const when = formatInZone(at, zone, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  return `${when} (${zone})`
}

// The token must never reach an error message (runTool logs failed calls).
const redact = (s, secret) => String(s ?? '').split(secret).join('[redacted]')

export default defineTool({
  name: 'send_email_for_approval',
  title: 'Send email for approval',
  description: 'Emails the person you are working for a test of a draft or scheduled email campaign, at their own '
    + 'login address, with a banner showing the head count, the address it sends as and the timing. The person '
    + 'approves it in the CRM from the link in that email; never look for, open or follow that link yourself. '
    + 'Nothing is sent to members until they do. send_at is a studio date and time (YYYY-MM-DDTHH:mm, in the future, '
    + 'at most 90 days out); omit it to send as soon as it is approved. Calling this again replaces any waiting '
    + 'approval, which is also how to move a scheduled campaign to a new time. '
    + 'This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    campaign_id: uuidLike.describe('The campaign id (see list_email_campaigns).'),
    send_at: z.string().trim().optional().describe('Studio date and time YYYY-MM-DDTHH:mm; omit for as soon as approved.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio, zone, nowMs } = ctx
    const to = typeof user?.user?.email === 'string' ? user.user.email.trim() : ''
    if (!to || !to.includes('@')) {
      throw new ToolRefusal('conflict', 'Your login has no email address, so there is nowhere to send the test.')
    }

    const campaign = await loadCampaignAtStudio(db, studio, input.campaign_id)
    if (!TESTABLE_STATUSES.includes(campaign.status)) {
      throw new ToolRefusal('conflict', `This campaign is ${campaign.status}, so it cannot be sent for approval.`
        + (campaign.status === 'failed' ? ' Open it in the CRM.' : ''))
    }
    // A/B test, resend or utility stream: the test and the approve page show
    // none of them, so the CRM sends those (also re-judged on the approve page).
    const blocker = agentReleaseBlocker(campaign)
    if (blocker) throw new ToolRefusal('conflict', blocker)
    if (!hasFilterRows(campaign.audience_filter)) {
      throw new ToolRefusal('invalid_input', 'This campaign has no audience: choose an audience first (update_email_draft with segment_id or filter).')
    }

    let sendAt = null
    if (input.send_at !== undefined) {
      const parsed = parseSendAt(input.send_at, zone, nowMs)
      if (!parsed.ok) throw new ToolRefusal('invalid_input', parsed.message)
      sendAt = parsed.at
    }

    const preflight = await releasePreflight(db, campaign, { statuses: TESTABLE_STATUSES })
    if (!preflight.ok) throw new ToolRefusal('conflict', preflight.message)

    let audience
    try {
      audience = await emailAudienceCounts(db, { filter: stripUnsetFilterRows(campaign.audience_filter), locationId: studio.id })
    } catch (e) {
      if (e instanceof InvalidAudienceFilterError) {
        throw new ToolRefusal('invalid_input', `The campaign's audience filter is not valid (${e.message}); choose an audience again.`)
      }
      throw e
    }
    if (!(audience.eligible > 0)) {
      throw new ToolRefusal('conflict', 'Nobody would receive this: the audience has no one who can be emailed. Choose another audience.')
    }

    const { sends_as: sendsAs } = await describeFromAddress(db, studio.id, campaign.from_email ?? null)

    const issued = await issueApproval(db, {
      campaign, profileId: user.id, audienceEligible: audience.eligible, sendAt, nowMs,
    })
    if (!issued.ok) {
      throw new ToolRefusal('conflict', 'Too many tests of this campaign in the last hour. Wait a while, then try again.')
    }
    const { token, expiresAt } = issued

    try {
      const appUrl = getAppUrl()
      const timing = timingLabel(sendAt, zone)
      const [branding, emailCopy, sender] = await Promise.all([
        getLocationBranding(db, studio.id),
        fetchLocationEmailCopy(db, studio.id),
        resolveEmailSender(db, studio.id),
      ])
      const { subject, html } = buildCampaignTestEmail({
        campaign,
        studio,
        person: { name: user.full_name || to.split('@')[0], email: to },
        branding,
        approveUrl: `${appUrl}/communications/campaigns/approve/${token}`,
        audienceEligible: audience.eligible,
        sendsAs,
        sendAtLabel: timing,
        appUrl,
        emailCopy,
      })
      // Transactional: one staff member's own test, so no List-Unsubscribe
      // header, no broadcast stream and no email_sends row.
      await sendEmail({
        to,
        subject,
        htmlBody: html,
        sender: withRequestedFrom(sender, campaign.from_email),
        fromName: campaign.from_name || undefined,
        replyTo: campaign.reply_to || undefined,
        stream: 'outbound',
        tag: 'campaign-approval-test',
        metadata: { campaign_id: campaign.id, test_send: '1', sent_by: user.id || '' },
      })
      return {
        sent_to: maskEmail(to),
        audience,
        sends_as: sendsAs,
        timing,
        expires_at: expiresAt,
      }
    } catch (e) {
      // The person never got the link, so the approval just issued is withdrawn.
      let voidFailed = ''
      try {
        await voidApprovals(db, campaign.id)
      } catch (ve) {
        voidFailed = ` Withdrawing the approval also failed: ${redact(ve?.message, token)}`
      }
      throw new Error(`The test email could not be sent: ${redact(e?.message, token)}.${voidFailed}`)
    }
  },
})
