// COMMS-AUDIT 2026-07-10 — campaigns.total_unsubscribed was never
// incremented anywhere: the SubscriptionChange handler applied the
// opt-out (via applyMarketingPreferencesBulk) but only selected
// contact_id off the email_sends row, never campaign_id, and never
// called increment_campaign_metric — while every other campaign counter
// (delivered/opened/clicked/bounced/complained) does. These tests pin
// the wiring: an unsubscribe that ORIGINATED from a campaign email
// increments that campaign's total_unsubscribed, exactly once (only
// when the flag actually flipped, so replays / already-unsubscribed
// contacts don't inflate it).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./marketing-consent.js', () => ({
  applyMarketingPreferencesBulk: vi.fn(),
}))
vi.mock('./bca-events.js', () => ({
  findBcaSubmissionByMessageId: vi.fn(),
  recordBcaPostmarkEvent: vi.fn(),
}))

import { processPostmarkEvent } from './postmark-webhook-processor.js'
import { applyMarketingPreferencesBulk } from './marketing-consent.js'

function stubDb({ send, rpcCalls }) {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: table === 'email_sends' ? send : null, error: null }),
        }),
      }),
      update: () => ({
        eq: () => ({
          in: () => Promise.resolve({ error: null }),
          then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject),
        }),
      }),
    }),
    rpc: (fn, args) => {
      rpcCalls.push([fn, args])
      return Promise.resolve({ error: null })
    },
  }
}

const EVENT = {
  RecordType: 'SubscriptionChange',
  MessageID: 'pm-1',
  SuppressSending: true,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('processPostmarkEvent — SubscriptionChange', () => {
  it('increments total_unsubscribed for the source campaign when the opt-out actually flipped', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: 'camp1' }, rpcCalls })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, skipped: null, changed: ['email_marketing'] })

    const r = await processPostmarkEvent(db, EVENT)
    expect(r.ok).toBe(true)
    expect(applyMarketingPreferencesBulk).toHaveBeenCalledWith(db, expect.objectContaining({
      contactId: 'c1',
      prefs: { email_marketing: false },
      source: 'postmark_one_click_unsubscribe',
    }))
    expect(rpcCalls).toContainEqual([
      'increment_campaign_metric',
      { p_campaign_id: 'camp1', p_field: 'total_unsubscribed' },
    ])
  })

  it('does NOT increment when the contact was already unsubscribed (no flip → replay-safe)', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: 'camp1' }, rpcCalls })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, skipped: null, changed: [] })

    const r = await processPostmarkEvent(db, EVENT)
    expect(r.ok).toBe(true)
    expect(rpcCalls).toEqual([])
  })

  it('applies the opt-out but skips the counter for a non-campaign (transactional) send', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: null }, rpcCalls })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, skipped: null, changed: ['email_marketing'] })

    const r = await processPostmarkEvent(db, EVENT)
    expect(r.ok).toBe(true)
    expect(applyMarketingPreferencesBulk).toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })

  it('ignores a re-subscribe (SuppressSending=false)', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: 'camp1' }, rpcCalls })

    const r = await processPostmarkEvent(db, { ...EVENT, SuppressSending: false })
    expect(r.ok).toBe(true)
    expect(applyMarketingPreferencesBulk).not.toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })
})
