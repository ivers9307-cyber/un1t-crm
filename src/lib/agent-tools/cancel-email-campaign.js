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

// The resend child of a campaign, read at THIS studio. An unreadable child is
// not "no child": acting on that could hide a running resend.
async function findResendChild(db, studio, campaign) {
  const { data: child, error } = await db
    .from('campaigns')
    .select('id')
    .eq('parent_campaign_id', campaign.id)
    .eq('location_id', studio.id)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to check whether the resend has started: ${error.message}`)
  return child ?? null
}

const resendStarted = (child) => new ToolRefusal('conflict', `The resend has already started. Cancel it instead: ${child.id}.`)

// A sent root campaign: a started resend is its own campaign (cancel that one);
// a pending one is just resend_enabled on the parent. Returns null when this
// campaign has no resend to deal with (the normal stop path then answers).
async function cancelResendOnSent(db, studio, campaign) {
  const started = await findResendChild(db, studio, campaign)
  if (started) throw resendStarted(started)
  if (!campaign.resend_enabled) return null
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
  // The spawner may have inserted the child between our read and the clear.
  const raced = await findResendChild(db, studio, campaign)
  if (raced) throw resendStarted(raced)
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
    if (campaign.status === 'sent' && !campaign.parent_campaign_id) {
      const resent = await cancelResendOnSent(db, studio, campaign)
      if (resent) return resent
    }
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
