// CAMPHIST.1 — one definition of "may this campaign's content still change?".
//
// It was previously stated in three places that disagreed:
//   • PUT /api/campaigns/[id] refused anything outside draft/scheduled (409);
//   • POST /api/campaigns/[id]/send allowed draft/scheduled/failed;
//   • the editor page, and CampaignEditor's direct browser write, checked
//     NOTHING — which is how ?edit=1 on a sent campaign came to overwrite it.
//
// Editability is not the same question as sendability, so this module answers
// only the first one and leaves /send's list alone.

import { describe, it, expect } from 'vitest'
import {
  EDITABLE_CAMPAIGN_STATUSES,
  isCampaignContentEditable,
  campaignLockedReason,
} from './campaign-editability.js'

describe('isCampaignContentEditable', () => {
  it('allows a draft', () => {
    expect(isCampaignContentEditable('draft')).toBe(true)
  })

  it('allows a scheduled campaign — it has not gone out yet', () => {
    expect(isCampaignContentEditable('scheduled')).toBe(true)
  })

  it.each(['queued', 'sending', 'sent', 'cancelled'])('locks %s', (status) => {
    expect(isCampaignContentEditable(status)).toBe(false)
  })

  it('locks a failed campaign', () => {
    // 'failed' is re-SENDABLE (COMMSFIX.C.5) but not re-WRITABLE: the cron
    // assigns it after a populate error, by which point campaign_recipients
    // rows may already exist and some mail may already have gone out.
    expect(isCampaignContentEditable('failed')).toBe(false)
  })

  it('locks an unknown or missing status — fails CLOSED', () => {
    // The column is plain TEXT with no CHECK (mig 005), so a value we do not
    // recognise is entirely possible. Guessing "editable" would risk
    // rewriting a sent campaign; guessing "locked" costs an operator one
    // duplicate. Fail towards the recoverable mistake.
    expect(isCampaignContentEditable('something_new')).toBe(false)
    expect(isCampaignContentEditable(null)).toBe(false)
    expect(isCampaignContentEditable(undefined)).toBe(false)
  })

  it('treats a missing campaign as a new draft', () => {
    // CampaignEditor renders with no campaign at all when composing fresh.
    expect(isCampaignContentEditable('draft')).toBe(true)
    expect(EDITABLE_CAMPAIGN_STATUSES).toContain('draft')
  })
})

describe('campaignLockedReason', () => {
  it('is null while the campaign is still editable', () => {
    expect(campaignLockedReason('draft')).toBeNull()
  })

  it('names the status and points at duplicating, without an em-dash', () => {
    const reason = campaignLockedReason('sent')
    expect(reason).toContain('sent')
    expect(reason.toLowerCase()).toContain('duplicate')
    expect(reason).not.toContain('—')
  })
})
