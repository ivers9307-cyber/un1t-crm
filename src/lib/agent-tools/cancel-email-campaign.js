// MCPEMAIL.1 — `cancel_email_campaign`: stop a scheduled, queued or sending
// email campaign. Uses the CRM's own stop rules (campaign-release.js), then
// withdraws every waiting approval, so an approve link still in the person's
// inbox is dead after "cancel it". A plain draft has nothing to stop, but a
// live approval on it is still withdrawn.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool, ToolRefusal } from './registry.js'
import { stopCampaign } from '@/lib/campaign-release'
import { voidApprovals, pendingApproval } from '@/lib/campaign-approval'
import { emailGate, loadCampaignAtStudio } from './_email-campaign.js'

const VOID_AFTER_STOP_FAILED = 'The campaign was stopped, but withdrawing the earlier approval failed. '
  + 'Send a new test before anything is approved.'

async function cancelPendingResend(db, studio, campaign) {
  const { data: child, error: childError } = await db
    .from('campaigns')
    .select('id')
    .eq('parent_campaign_id', campaign.id)
    .eq('location_id', studio.id)
    .limit(1)
    .maybeSingle()
  // An unreadable child is not "no child": clearing the flag could hide a running resend.
  if (childError) throw new Error(`Failed to check whether the resend has started: ${childError.message}`)
  if (child) throw new ToolRefusal('conflict', `The resend has already started. Cancel it instead: ${child.id}.`)
  const { data, error } = await db
    .from('campaigns')
    .update({ resend_enabled: false })
    .eq('id', campaign.id)
    .eq('location_id', studio.id)
    .eq('status', 'sent')
    .eq('resend_enabled', true)
    .select('id')
  if (error) throw new Error(`Failed to cancel the resend: ${error.message}`)
  if (!Array.isArray(data) || data.length === 0) {
    throw new ToolRefusal('conflict', 'The resend changed while it was being cancelled. Check it with get_email_campaign.')
  }
  return { outcome: 'resend_cancelled', status: 'sent' }
}

export default defineTool({
  name: 'cancel_email_campaign',
  title: 'Cancel email campaign',
  description: 'Stops an email campaign: a scheduled one goes back to draft, a queued or sending one is asked to '
    + 'stop (emails already sent cannot be recalled), and a draft waiting for approval has that approval withdrawn. '
    + 'Any waiting approval is withdrawn either way. On a sent campaign it switches off a resend to non-openers that has not started. Anything else is refused. '
    + 'This writes to the CRM: confirm with the user first.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
    campaign_id: uuidLike.describe('The campaign id (see list_email_campaigns).'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, studio, nowMs } = ctx
    // Only a campaign loaded at THIS studio is ever handed to stopCampaign.
    const campaign = await loadCampaignAtStudio(db, studio, input.campaign_id)
    // A sent campaign has nothing to stop, but a pending resend to non-openers
    // (just resend_enabled on it until the spawner fires) can still be switched off.
    if (campaign.status === 'sent' && campaign.resend_enabled) return cancelPendingResend(db, studio, campaign)
    const result = await stopCampaign(db, campaign)
    if (result.ok) {
      try {
        await voidApprovals(db, campaign.id)
      } catch {
        throw new ToolRefusal('conflict', VOID_AFTER_STOP_FAILED)
      }
      return { outcome: result.outcome, status: result.status }
    }
    if (result.code === 'not_stoppable') {
      // A draft has nothing to stop, but its waiting approval can still be pressed.
      if (campaign.status === 'draft') {
        const live = await pendingApproval(db, campaign.id, nowMs)
        if (live) {
          await voidApprovals(db, campaign.id)
          return { outcome: 'approval_withdrawn', status: 'draft' }
        }
      }
      throw new ToolRefusal('conflict', result.message)
    }
    throw new Error(`Failed to stop the campaign: ${result.message}`)
  },
})
