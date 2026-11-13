// MCPEMAIL.1 — `update_email_draft`: edit a draft or scheduled email campaign.
// An edit returns a scheduled campaign to draft and withdraws any outstanding
// send approval, so what a person approved is never what goes out after an edit.

import { z } from 'zod'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { defineTool, ToolRefusal } from './registry.js'
import { EDITABLE_CAMPAIGN_STATUSES } from '@/lib/campaign-editability'
import { voidApprovals } from '@/lib/campaign-approval'
import { emailGate, loadCampaignAtStudio, resolveAudienceFilter, htmlSha256 } from './_email-campaign.js'
import { BODY_EDITED_IN_CRM, EmailBlocksSchema, ResendSchema, buildBody, resendColumns, checkReplyTo, sendsAs, throwWriteError } from './_email-draft.js'

const FIELDS = ['name', 'subject', 'preview_text', 'from_name', 'reply_to', 'blocks', 'segment_id', 'filter', 'resend']

function notEditable(status) {
  return new ToolRefusal('conflict', `This campaign is ${status}, so it cannot be edited here.`
    + (status === 'failed' ? ' Open it in the CRM.' : ''))
}

export default defineTool({
  name: 'update_email_draft',
  title: 'Update email draft',
  description: 'Edits a draft or scheduled email campaign (give the campaign id and at least one field). Passing '
    + 'blocks replaces the body, which is refused if someone edited the body in the CRM since. Passing segment_id or '
    + 'filter replaces the audience. Passing resend sets, or with null removes, the resend to people who did not open it. Editing a scheduled campaign returns it to draft and withdraws any waiting send '
    + 'approval. It never sends. This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    campaign_id: uuidLike.describe('The campaign id (see list_email_campaigns).'),
    name: z.string().trim().min(1).max(200).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    preview_text: z.string().trim().max(500).optional(),
    from_name: z.string().trim().max(100).optional(),
    reply_to: z.string().trim().email().max(254).optional().describe('On the studio\'s verified domain.'),
    blocks: EmailBlocksSchema.optional().describe('The whole new body, 1 to 60 blocks.'),
    segment_id: uuidLike.optional().describe('A saved segment at this studio, instead of filter.'),
    filter: audienceFilterSchema.describe('An inline audience filter, instead of segment_id.'),
    resend: ResendSchema.describe('after_hours (1 to 168) and an optional subject to resend to people who did not open it; null switches the resend off; omit to leave it.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    if (!FIELDS.some((k) => input[k] !== undefined)) {
      throw new ToolRefusal('invalid_input', 'Give at least one field to change besides campaign_id.')
    }
    const campaign = await loadCampaignAtStudio(db, studio, input.campaign_id)
    if (!EDITABLE_CAMPAIGN_STATUSES.includes(campaign.status)) throw notEditable(campaign.status)

    const patch = {}
    for (const k of ['name', 'subject', 'preview_text', 'from_name']) if (input[k] !== undefined) patch[k] = input[k]

    if (input.reply_to !== undefined) {
      await checkReplyTo(db, studio, input.reply_to)
      patch.reply_to = input.reply_to
    }
    if (input.resend != null && campaign.parent_campaign_id) {
      throw new ToolRefusal('invalid_input', 'This campaign is itself a resend, and a resend cannot itself be resent.')
    }
    Object.assign(patch, resendColumns(input.resend))
    if (input.segment_id != null || input.filter != null) {
      patch.audience_filter = await resolveAudienceFilter(db, studio, user, input)
    }
    if (input.blocks !== undefined) {
      const stored = campaign.agent_blocks
      if (!stored || htmlSha256(campaign.html_content ?? '') !== stored.html_sha256) {
        throw new ToolRefusal('conflict', BODY_EDITED_IN_CRM)
      }
      Object.assign(patch, await buildBody(db, user, studio, input.blocks))
    }

    // Always return the row to draft: a release between our read and this
    // write (draft → scheduled) must not leave new content scheduled.
    const unscheduled = campaign.status === 'scheduled'
    Object.assign(patch, { status: 'draft', scheduled_at: null })

    const { data, error } = await db.from('campaigns')
      .update(patch)
      .eq('id', campaign.id)
      .eq('location_id', studio.id)
      .in('status', EDITABLE_CAMPAIGN_STATUSES)
      .select('id')
    if (error) throwWriteError(error, 'update the campaign')
    if (!Array.isArray(data) || data.length === 0) {
      let now = 'no longer editable'
      try { now = (await loadCampaignAtStudio(db, studio, campaign.id)).status } catch { /* keep the generic words */ }
      throw new ToolRefusal('conflict', `The campaign changed while it was being edited and is now ${now}. Check it with get_email_campaign.`)
    }

    // The content has changed: any approval for the old content is withdrawn.
    // If this throws the call fails, but the old approval is dead anyway (its
    // content key no longer matches).
    try {
      await voidApprovals(db, campaign.id)
    } catch {
      throw new ToolRefusal('conflict', 'The edit was saved, but withdrawing the earlier approval failed. Send a new test before anything is approved.')
    }

    return {
      campaign: {
        id: campaign.id,
        name: patch.name ?? campaign.name,
        subject: patch.subject ?? campaign.subject,
        status: 'draft',
        sends_as: await sendsAs(db, studio),
      },
      unscheduled,
      note: unscheduled
        ? 'The campaign was scheduled; it is back to draft and any send approval was withdrawn. It needs approving again.'
        : 'The campaign is a draft; sending it needs a new test and approval.',
    }
  },
})
