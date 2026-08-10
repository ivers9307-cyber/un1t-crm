// REPORT-SOT.2 — one number on screen per campaign.
//
// campaigns.total_* and campaign_recipients disagree, and every surface read
// the counters. The counters come from recalculate_campaign_stats (mig 157),
// which counts email_sends — and a SEND-TIME REJECTION (Postmark 300 invalid /
// 406 inactive) never gets an email_sends row at all: campaign-sender writes it
// straight onto campaign_recipients as bounce_type='rejected'. So every
// rejection is invisible to the counter.
//
// Measured live 2026-08-10, the gap on the number that matters most for
// reputation:
//
//     campaign                    total_bounced   recipients bounced
//     Hatch Street Announcement              14                   54
//     Email 12 Jun 23:18                      0                   40
//     Train for FREE (5 Aug)                  4                   41
//     Email 8 Aug 21:11                       2                   21
//
// The stored counters are deliberately NOT repaired. This module changes what
// is displayed and nothing else.

import { describe, it, expect, vi } from 'vitest'
import {
  campaignDisplayStats,
  loadCampaignRecipientStats,
  NO_RECIPIENT_STATS,
  pct,
} from './campaign-display-stats.js'

// Hatch Street Announcement, exactly as both sources hold it.
const HATCH_COUNTERS = {
  id: 'f1297660',
  total_recipients: 3055,
  total_sent: 3047,
  total_delivered: 3008,
  total_opened: 1338,
  total_clicked: 192,
  total_bounced: 14,
  total_complained: 0,
}
const HATCH_RECIPIENTS = {
  campaign_id: 'f1297660',
  recipients: 3055,
  sent: 3050,
  delivered: 2898,
  opened: 1338,
  clicked: 192,
  bounced: 54,
  complained: 0,
  unsubscribed: 0,
  failed: 0,
}

const statsFor = (rows) => ({ ok: true, byCampaign: new Map(rows.map((r) => [r.campaign_id, r])) })

describe('campaignDisplayStats — campaign_recipients is what gets displayed', () => {
  const s = campaignDisplayStats(HATCH_COUNTERS, statsFor([HATCH_RECIPIENTS]))

  it('reports which source produced the figures', () => {
    expect(s.source).toBe('recipients')
  })

  it('shows the 54 bounces the counter reports as 14', () => {
    expect(s.bounced).toBe(54)
  })

  it('shows the recipient-side send count, not the counter', () => {
    expect(s.sent).toBe(3050)
  })

  it('carries every figure the surfaces render', () => {
    expect(s.recipients).toBe(3055)
    expect(s.delivered).toBe(2898)
    expect(s.opened).toBe(1338)
    expect(s.clicked).toBe(192)
    expect(s.complained).toBe(0)
    expect(s.failed).toBe(0)
  })

  it('computes the rates on the displayed denominator, so they cannot disagree with it', () => {
    expect(s.open_rate).toBeCloseTo(1338 / 3050, 9)
    expect(s.bounce_rate).toBeCloseTo(54 / 3050, 9)
    expect(pct(s.bounce_rate)).toBe('1.8%')
  })
})

describe('campaignDisplayStats — a campaign the RPC returned no row for', () => {
  // GROUP BY means a campaign with zero recipient rows is simply absent from
  // the result. That is a real zero, not a missing answer, and must not be
  // silently replaced by a stale counter.
  const s = campaignDisplayStats({ id: 'nobody', total_sent: 900, total_bounced: 3 }, statsFor([]))

  it('reads as zero from campaign_recipients rather than falling back', () => {
    expect(s.source).toBe('recipients')
    expect(s.sent).toBe(0)
    expect(s.bounced).toBe(0)
  })

  it('leaves the rates null rather than dividing by nothing', () => {
    expect(s.open_rate).toBe(null)
    expect(pct(s.open_rate)).toBe('0%')
  })
})

describe('campaignDisplayStats — the RPC failed', () => {
  // The page still has to render. It falls back to the stored counters and
  // SAYS which source it used, so the surface can label them rather than
  // presenting a second set of numbers as if it were the first.
  const s = campaignDisplayStats(HATCH_COUNTERS, NO_RECIPIENT_STATS)

  it('falls back to the stored counters', () => {
    expect(s.source).toBe('counters')
    expect(s.sent).toBe(3047)
    expect(s.bounced).toBe(14)
  })

  it('keeps the old total_sent-or-total_recipients fallback for the denominator', () => {
    const t = campaignDisplayStats({ id: 'x', total_recipients: 40 }, NO_RECIPIENT_STATS)
    expect(t.sent).toBe(40)
  })

  it('is what a missing stats argument produces too', () => {
    expect(campaignDisplayStats(HATCH_COUNTERS, null).source).toBe('counters')
    expect(campaignDisplayStats(HATCH_COUNTERS, undefined).bounced).toBe(14)
  })
})

describe('pct', () => {
  it('formats a fraction to one place, like the surfaces already did', () => {
    expect(pct(0.4387)).toBe('43.9%')
    expect(pct(0)).toBe('0%')
    expect(pct(null)).toBe('0%')
  })
})

describe('loadCampaignRecipientStats', () => {
  it('makes one call for every id, not one call per campaign', async () => {
    const rpc = vi.fn(async () => ({ data: [HATCH_RECIPIENTS], error: null }))
    const out = await loadCampaignRecipientStats({ rpc }, ['f1297660', 'other'])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('campaign_recipient_stats', { p_campaign_ids: ['f1297660', 'other'] })
    expect(out.ok).toBe(true)
    expect(out.byCampaign.get('f1297660').bounced).toBe(54)
  })

  it('does not call the database for an empty list', async () => {
    const rpc = vi.fn()
    const out = await loadCampaignRecipientStats({ rpc }, [])
    expect(rpc).not.toHaveBeenCalled()
    expect(out.ok).toBe(true)
  })

  it('reports a failure rather than passing empty stats off as zero', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    const out = await loadCampaignRecipientStats({ rpc }, ['a'])
    expect(out.ok).toBe(false)
    expect(out.error).toBe('boom')
  })

  it('survives a thrown rpc, because supabase builders are thenables', async () => {
    const rpc = vi.fn(async () => { throw new Error('network') })
    const out = await loadCampaignRecipientStats({ rpc }, ['a'])
    expect(out.ok).toBe(false)
    expect(out.byCampaign.size).toBe(0)
  })

  it('drops ids that are not strings so a null never reaches the array argument', async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }))
    await loadCampaignRecipientStats({ rpc }, ['a', null, undefined, 'b'])
    expect(rpc).toHaveBeenCalledWith('campaign_recipient_stats', { p_campaign_ids: ['a', 'b'] })
  })
})

// REPORT-SOT.3 — delivered is the one figure campaign_recipients cannot always
// stand behind, because delivered_at was not stamped before June 2026 (1.2%
// coverage in May: 36 rows of 2,998, against 777 opens).
describe('campaignDisplayStats — incomplete delivered', () => {
  const statsFor = (counts) => ({ ok: true, byCampaign: new Map([['c1', counts]]) })

  it('suppresses delivered when it is provably incomplete (fewer delivered than opened)', () => {
    // The real May campaign: 2,998 sent, 36 delivered_at stamps, 777 opens.
    const out = campaignDisplayStats({ id: 'c1' }, statsFor({
      recipients: 2998, sent: 2998, delivered: 36, opened: 777, clicked: 0, bounced: 36,
    }))
    expect(out.delivered).toBeNull()
    expect(out.delivered_incomplete).toBe(true)
    // Everything else still comes from campaign_recipients.
    expect(out.sent).toBe(2998)
    expect(out.opened).toBe(777)
    expect(out.bounced).toBe(36)
  })

  it('shows delivered when the count can support itself', () => {
    // The real 8 Aug campaign: 376 delivered against 291 opens.
    const out = campaignDisplayStats({ id: 'c1' }, statsFor({
      recipients: 994, sent: 994, delivered: 376, opened: 291, clicked: 0, bounced: 21,
    }))
    expect(out.delivered).toBe(376)
    expect(out.delivered_incomplete).toBe(false)
  })

  it('treats equal delivered and opened as complete, not incomplete', () => {
    const out = campaignDisplayStats({ id: 'c1' }, statsFor({
      recipients: 10, sent: 10, delivered: 5, opened: 5, clicked: 0, bounced: 0,
    }))
    expect(out.delivered).toBe(5)
    expect(out.delivered_incomplete).toBe(false)
  })

  it('a campaign nobody opened keeps its delivered figure', () => {
    const out = campaignDisplayStats({ id: 'c1' }, statsFor({
      recipients: 100, sent: 100, delivered: 98, opened: 0, clicked: 0, bounced: 2,
    }))
    expect(out.delivered).toBe(98)
    expect(out.delivered_incomplete).toBe(false)
  })
})
