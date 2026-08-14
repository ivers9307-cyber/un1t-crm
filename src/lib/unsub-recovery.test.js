// UNSUBRECOVER.1 — tests for the click-evidence classifier. See the header
// comment in unsub-recovery.js for the two dropped-opt-out causes, the
// burst-rule measurement that got it REJECTED against prod, and the
// coverage rule that replaced it.

import { describe, it, expect } from 'vitest'
import {
  BURST_BUCKET_MINUTES,
  BURST_ADVISORY_CONTACTS,
  SCANNER_COVERAGE_THRESHOLD,
  REVIEW_COVERAGE_THRESHOLD,
  burstBucketKey,
  buildBurstIndex,
  classifyClickEvidence,
} from './unsub-recovery.js'

describe('burstBucketKey', () => {
  it('floors 18:47 and 18:46 into the same 2-minute bucket', () => {
    expect(burstBucketKey('2026-05-17T18:46:00Z')).toBe(burstBucketKey('2026-05-17T18:47:59Z'))
  })

  it('puts 18:48 in a different bucket from 18:46/18:47', () => {
    expect(burstBucketKey('2026-05-17T18:48:00Z')).not.toBe(burstBucketKey('2026-05-17T18:47:00Z'))
  })

  it('produces the documented bucket key shape', () => {
    expect(burstBucketKey('2026-05-17T18:46:00Z')).toBe('2026-05-17T18:46')
  })
})

describe('buildBurstIndex', () => {
  it('counts DISTINCT contacts per bucket, not rows', () => {
    // Same contact, two clicks, same bucket — must count as 1, not 2.
    const rows = [
      { contact_id: 'A', clicked_at: '2026-05-17T18:46:05Z' },
      { contact_id: 'A', clicked_at: '2026-05-17T18:46:50Z' },
    ]
    const index = buildBurstIndex(rows)
    expect(index[burstBucketKey('2026-05-17T18:46:05Z')]).toBe(1)
  })

  it('counts each distinct contact once even across multiple buckets', () => {
    const rows = [
      { contact_id: 'A', clicked_at: '2026-05-17T18:46:05Z' },
      { contact_id: 'B', clicked_at: '2026-05-17T18:46:15Z' },
      { contact_id: 'C', clicked_at: '2026-05-17T18:46:25Z' },
    ]
    const index = buildBurstIndex(rows)
    expect(index[burstBucketKey('2026-05-17T18:46:05Z')]).toBe(3)
  })
})

// classifyClickEvidence — coverage is the primary (and only) discriminator.
// The burst rule was measured against prod 2026-08-14 and rejected: sweeping
// BURST_CONTACT_THRESHOLD from 3 to 20 moved the human/scanner split from
// 21/139 to 155/5 with no plateau anywhere, which is the signature of a
// threshold cutting through one continuous population rather than
// separating two. A link-scanner clicks (close to) every delivered
// campaign; measured live, 152 of 161 click-havers clicked under 50% of
// what they were sent and 0 were anywhere near 90%. Full story in the
// unsub-recovery.js header comment — do not resurrect burst-driven verdicts.
describe('classifyClickEvidence — coverage rule', () => {
  it('coverage 1.0 (clicked every delivered campaign) -> scanner', () => {
    // 3 raw click rows but only 2 DISTINCT campaigns, out of 2 delivered —
    // proves clickedCampaigns is campaign-distinct, not a raw click count.
    const clicks = [
      { campaign_id: 'camp1', clicked_at: '2026-05-01T10:00:00Z' },
      { campaign_id: 'camp1', clicked_at: '2026-05-01T10:05:00Z' },
      { campaign_id: 'camp2', clicked_at: '2026-05-08T10:00:00Z' },
    ]
    const burstIndex = buildBurstIndex(clicks.map(c => ({ contact_id: 'X', clicked_at: c.clicked_at })))

    const result = classifyClickEvidence({ clicks, campaignsDelivered: 2, burstIndex })

    expect(result.coverage).toBe(1)
    expect(result.clickedCampaigns).toBe(2)
    expect(result.clickCount).toBe(3)
    expect(result.verdict).toBe('scanner')
  })

  it('coverage 0.6 (3 of 5 delivered campaigns clicked) -> review', () => {
    const clicks = [
      { campaign_id: 'c1', clicked_at: '2026-05-01T10:00:00Z' },
      { campaign_id: 'c2', clicked_at: '2026-05-08T10:00:00Z' },
      { campaign_id: 'c3', clicked_at: '2026-05-15T10:00:00Z' },
    ]
    const burstIndex = buildBurstIndex(clicks.map(c => ({ contact_id: 'X', clicked_at: c.clicked_at })))

    const result = classifyClickEvidence({ clicks, campaignsDelivered: 5, burstIndex })

    expect(result.coverage).toBeCloseTo(0.6)
    expect(result.verdict).toBe('review')
  })

  it('coverage 0.14 (1 of 7 delivered campaigns clicked) -> human', () => {
    const clicks = [{ campaign_id: 'c1', clicked_at: '2026-05-01T10:00:00Z' }]
    const burstIndex = buildBurstIndex(clicks.map(c => ({ contact_id: 'X', clicked_at: c.clicked_at })))

    const result = classifyClickEvidence({ clicks, campaignsDelivered: 7, burstIndex })

    expect(result.coverage).toBeCloseTo(0.142857, 5)
    expect(result.verdict).toBe('human')
  })

  it('a contact who received exactly ONE campaign and clicked its unsubscribe link is indistinguishable from a scanner on this signal alone, so a single isolated click with campaignsDelivered=1 lands in scanner — but the identical click against a 4-campaign delivery history is human', () => {
    const clicks = [{ campaign_id: 'only-campaign', clicked_at: '2026-06-01T10:00:00Z' }]
    const burstIndex = buildBurstIndex(clicks.map(c => ({ contact_id: 'X', clicked_at: c.clicked_at })))

    const oneDelivered = classifyClickEvidence({ clicks, campaignsDelivered: 1, burstIndex })
    expect(oneDelivered.coverage).toBe(1)
    expect(oneDelivered.verdict).toBe('scanner')

    const fourDelivered = classifyClickEvidence({ clicks, campaignsDelivered: 4, burstIndex })
    expect(fourDelivered.coverage).toBe(0.25)
    expect(fourDelivered.verdict).toBe('human')
  })

  it('campaignsDelivered 0 -> coverage null -> human (fails open: no denominator to doubt the request with)', () => {
    const clicks = [{ campaign_id: 'c1', clicked_at: '2026-06-01T10:00:00Z' }]
    const burstIndex = buildBurstIndex(clicks.map(c => ({ contact_id: 'X', clicked_at: c.clicked_at })))

    const result = classifyClickEvidence({ clicks, campaignsDelivered: 0, burstIndex })

    expect(result.coverage).toBeNull()
    expect(result.verdict).toBe('human')
  })

  it('burst membership alone never produces scanner — coverage overrides it even when every click sits in an 8+ contact burst', () => {
    // 8 different contacts (X plus 7 others) all click within the same
    // 2-minute window, so X's one click is burst-suspect. X's coverage is
    // still only 1 of 10 delivered campaigns, so the verdict must stay
    // human — burst is evidence (burstClicks), never the verdict.
    const burstAt = '2026-05-17T18:46:00Z'
    const others = ['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((id, i) => ({
      contact_id: id,
      clicked_at: `2026-05-17T18:46:${String(10 + i).padStart(2, '0')}Z`,
    }))
    const xRow = { contact_id: 'X', clicked_at: burstAt }
    const burstIndex = buildBurstIndex([xRow, ...others])
    expect(burstIndex[burstBucketKey(burstAt)]).toBeGreaterThanOrEqual(BURST_ADVISORY_CONTACTS)

    const clicks = [{ campaign_id: 'c1', clicked_at: burstAt }]
    const result = classifyClickEvidence({ clicks, campaignsDelivered: 10, burstIndex })

    expect(result.burstClicks).toBe(1)
    expect(result.verdict).toBe('human')
  })

  it('reports spanDays across a real date range, independent of the verdict', () => {
    // The unambiguous-human example from the audit: one contact's clicks
    // ran from 8 Jun to 8 Aug (61 days).
    const clicks = [
      { campaign_id: 'c1', clicked_at: '2026-06-08T00:00:00Z' },
      { campaign_id: 'c2', clicked_at: '2026-08-08T00:00:00Z' },
    ]
    const burstIndex = buildBurstIndex(clicks.map(c => ({ contact_id: 'X', clicked_at: c.clicked_at })))

    const result = classifyClickEvidence({ clicks, campaignsDelivered: 10, burstIndex })

    expect(result.spanDays).toBeGreaterThan(60)
    expect(result.verdict).toBe('human')
  })

  it('spanDays is 0 for a single click', () => {
    const clicks = [{ campaign_id: 'c1', clicked_at: '2026-06-01T10:00:00Z' }]
    const burstIndex = buildBurstIndex(clicks.map(c => ({ contact_id: 'X', clicked_at: c.clicked_at })))

    const result = classifyClickEvidence({ clicks, campaignsDelivered: 10, burstIndex })

    expect(result.spanDays).toBe(0)
  })
})

describe('constants', () => {
  it('exposes the named thresholds used by the classifier (no magic numbers)', () => {
    expect(BURST_BUCKET_MINUTES).toBe(2)
    expect(BURST_ADVISORY_CONTACTS).toBe(8)
    expect(SCANNER_COVERAGE_THRESHOLD).toBe(0.9)
    expect(REVIEW_COVERAGE_THRESHOLD).toBe(0.5)
  })
})
