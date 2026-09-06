// HOST-CONSENT.1 — host-stream Postmark events land on HOST tables and never
// on contacts.email_marketing. Identified by Metadata.host_campaign_id (every
// host send stamps it), not by stream name — streams are per host.
// HOST-METRICS.1 — the same events also land per-send tracking on
// host_campaign_sends (resolved by campaign_id+contact_id), see the describe
// block at the bottom.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./host-consent.js', () => ({ revokeHostConsent: vi.fn().mockResolvedValue({ ok: true, changed: true }) }))

import { isHostCampaignEvent, processHostCampaignEvent } from './host-campaign-webhooks.js'
import { revokeHostConsent } from './host-consent.js'

const META = { host_campaign_id: 'hc-1', host_id: 'h-1', contact_id: 'c-1' }

function stubDb({ failTable, sendRow = null } = {}) {
  const contactUpdates = []
  const sendSelects = []
  const sendUpdates = []
  const rpcCalls = []
  return {
    contactUpdates,
    sendSelects,
    sendUpdates,
    rpcCalls,
    from: (table) => {
      const filters = []
      let isSelect = false
      let values
      const chain = {
        select: () => { isSelect = true; return chain },
        update: (v) => { values = v; return chain },
        eq: (c, v) => { filters.push([c, v]); return chain },
        in: (c, v) => { filters.push(['in', c, v]); return chain },
        is: (c, v) => { filters.push(['is', c, v]); return chain },
        maybeSingle: () => {
          if (table === 'host_campaign_sends') sendSelects.push({ filters })
          const result = table === failTable
            ? { data: null, error: { message: 'boom' } }
            : { data: sendRow, error: null }
          return Promise.resolve(result)
        },
        then: (resolve, reject) => {
          if (table === 'contacts') contactUpdates.push({ values, filters })
          if (table === 'host_campaign_sends' && !isSelect) sendUpdates.push({ values, filters })
          const result = table === failTable
            ? { data: null, error: { message: 'boom' } }
            : { data: null, error: null }
          return Promise.resolve(result).then(resolve, reject)
        },
      }
      return chain
    },
    rpc: (fn, args) => {
      rpcCalls.push([fn, args])
      return Promise.resolve({ error: null })
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeHostConsent.mockResolvedValue({ ok: true, changed: true })
})

describe('isHostCampaignEvent', () => {
  it('true when Metadata.host_campaign_id is present', () => {
    expect(isHostCampaignEvent({ Metadata: META })).toBe(true)
  })
  it('false otherwise (CRM sends, ops mail, no metadata)', () => {
    expect(isHostCampaignEvent({ Metadata: { crm_send: '1' } })).toBe(false)
    expect(isHostCampaignEvent({})).toBe(false)
    expect(isHostCampaignEvent(null)).toBe(false)
  })
})

describe('processHostCampaignEvent', () => {
  it('HardBounce marks the contact bounced (shared mailbox fact) and nothing else', async () => {
    const db = stubDb()
    const r = await processHostCampaignEvent(db, { RecordType: 'Bounce', Type: 'HardBounce', MessageID: 'm', Metadata: META })
    expect(r).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([{ values: { email_status: 'bounced' }, filters: [['id', 'c-1']] }])
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
  it('SoftBounce writes nothing', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'Bounce', Type: 'SoftBounce', MessageID: 'm', Metadata: META })
    expect(db.contactUpdates).toEqual([])
  })
  it('SpamComplaint marks complained AND revokes host consent', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'SpamComplaint', MessageID: 'm', Metadata: META })
    expect(db.contactUpdates[0].values).toEqual({ email_status: 'complained' })
    expect(revokeHostConsent).toHaveBeenCalledWith(db, { hostId: 'h-1', contactId: 'c-1', source: 'postmark_spam_complaint' })
  })
  it('SubscriptionChange SuppressSending=true revokes host consent only', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'SubscriptionChange', SuppressSending: true, MessageID: 'm', Metadata: META })
    expect(revokeHostConsent).toHaveBeenCalledWith(db, { hostId: 'h-1', contactId: 'c-1', source: 'postmark_one_click_unsubscribe' })
    expect(db.contactUpdates).toEqual([])
  })
  it('SubscriptionChange SuppressSending=false (reactivation) resets email_status only', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'SubscriptionChange', SuppressSending: false, MessageID: 'm', Metadata: META })
    expect(revokeHostConsent).not.toHaveBeenCalled()
    expect(db.contactUpdates).toEqual([{ values: { email_status: 'active' }, filters: [['id', 'c-1'], ['in', 'email_status', ['bounced', 'complained']]] }])
  })
  it.each(['Delivery', 'Open', 'Click'])('%s is acknowledged and parked for HOST-METRICS.1', async (t) => {
    const db = stubDb()
    expect(await processHostCampaignEvent(db, { RecordType: t, MessageID: 'm', Metadata: META })).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([])
  })
  it('a failed revoke is reported not-ok so the queue retries', async () => {
    revokeHostConsent.mockResolvedValueOnce({ ok: false, changed: false, error: 'db down' })
    const r = await processHostCampaignEvent(stubDb(), { RecordType: 'SubscriptionChange', SuppressSending: true, MessageID: 'm', Metadata: META })
    expect(r).toEqual({ ok: false, error: 'db down' })
  })
  it('a failed contact update is reported not-ok', async () => {
    const db = stubDb({ failTable: 'contacts' })
    const r = await processHostCampaignEvent(db, { RecordType: 'Bounce', Type: 'HardBounce', MessageID: 'm', Metadata: META })
    expect(r).toEqual({ ok: false, error: 'boom' })
  })
  it('SpamComplaint: a failed contact update aborts BEFORE the revoke', async () => {
    const db = stubDb({ failTable: 'contacts' })
    expect(await processHostCampaignEvent(db, { RecordType: 'SpamComplaint', MessageID: 'm', Metadata: META })).toEqual({ ok: false, error: 'boom' })
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
  it('host event missing host_id/contact_id metadata is acknowledged with nothing written', async () => {
    const db = stubDb()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await processHostCampaignEvent(db, { RecordType: 'SpamComplaint', MessageID: 'm', Metadata: { host_campaign_id: 'hc-1' } })
    expect(r).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([])
    expect(revokeHostConsent).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
  it('an unknown record type is acknowledged with a console.error and no writes', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubDb()
    expect(await processHostCampaignEvent(db, { RecordType: 'Weird', MessageID: 'm', Metadata: META })).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('processHostCampaignEvent — send row outcomes (HOST-METRICS.1)', () => {
  const ROW = { id: 'send-1', postmark_message_id: null }
  const ev = (RecordType, extra = {}) => ({ RecordType, MessageID: 'pm-9', Metadata: META, ...extra })
  it('resolves the row by (campaign_id, contact_id) and stamps the message id when null', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Delivery'))
    const sel = db.sendSelects[0]
    expect(sel.filters).toEqual(expect.arrayContaining([['campaign_id', 'hc-1'], ['contact_id', 'c-1']]))
    expect(db.sendUpdates.some((u) => u.values.postmark_message_id === 'pm-9' && u.filters.some((f) => f[0] === 'is' && f[1] === 'postmark_message_id'))).toBe(true)
  })
  it('does not re-stamp a message id the row already has', async () => {
    const db = stubDb({ sendRow: { id: 'send-1', postmark_message_id: 'pm-old' } })
    await processHostCampaignEvent(db, ev('Delivery'))
    expect(db.sendUpdates.some((u) => 'postmark_message_id' in u.values)).toBe(false)
  })
  it('Delivery stamps delivered_at guarded on null', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Delivery', { DeliveredAt: '2026-09-06T21:24:46Z' }))
    const u = db.sendUpdates.find((u) => 'delivered_at' in u.values)
    expect(u.values.delivered_at).toBe('2026-09-06T21:24:46Z')
    expect(u.filters).toEqual(expect.arrayContaining([['id', 'send-1'], ['is', 'delivered_at', null]]))
  })
  it('Open stamps opened_at once and bumps open_count every time', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Open', { ReceivedAt: '2026-09-06T21:25:17Z' }))
    expect(db.sendUpdates.find((u) => 'opened_at' in u.values).filters).toEqual(expect.arrayContaining([['is', 'opened_at', null]]))
    expect(db.rpcCalls).toEqual([['bump_host_send_counter', { p_send_id: 'send-1', p_field: 'open_count' }]])
  })
  it('Click stamps clicked_at + opened_at (a click implies an open) and bumps click_count', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Click', { ReceivedAt: 't' }))
    expect(db.sendUpdates.some((u) => 'clicked_at' in u.values)).toBe(true)
    expect(db.sendUpdates.some((u) => 'opened_at' in u.values)).toBe(true)
    expect(db.rpcCalls).toEqual([['bump_host_send_counter', { p_send_id: 'send-1', p_field: 'click_count' }]])
  })
  it('HardBounce stamps bounced_at + bounce_type on the row AND the shared mailbox fact', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Bounce', { Type: 'HardBounce', BouncedAt: 'b' }))
    expect(db.sendUpdates.find((u) => 'bounced_at' in u.values).values).toEqual({ bounced_at: 'b', bounce_type: 'hard' })
    expect(db.contactUpdates[0].values).toEqual({ email_status: 'bounced' })
  })
  it('SoftBounce stamps the row (soft) but not the contact', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Bounce', { Type: 'SoftBounce', BouncedAt: 'b' }))
    expect(db.sendUpdates.find((u) => 'bounced_at' in u.values).values.bounce_type).toBe('soft')
    expect(db.contactUpdates).toEqual([])
  })
  it('SpamComplaint stamps complained_at; SubscriptionChange stamps unsubscribed_at', async () => {
    let db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('SpamComplaint', { BouncedAt: 'c' }))
    expect(db.sendUpdates.some((u) => u.values.complained_at === 'c')).toBe(true)
    db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('SubscriptionChange', { SuppressSending: true, ChangedAt: 'u' }))
    expect(db.sendUpdates.some((u) => u.values.unsubscribed_at === 'u')).toBe(true)
  })
  it('no matching row (test send, deleted campaign) → acknowledged, nothing written to the row', async () => {
    const db = stubDb({ sendRow: null })
    expect(await processHostCampaignEvent(db, ev('Open'))).toEqual({ ok: true })
    expect(db.sendUpdates).toEqual([])
    expect(db.rpcCalls).toEqual([])
  })
  it('a HardBounce with no row still marks the mailbox', async () => {
    const db = stubDb({ sendRow: null })
    await processHostCampaignEvent(db, ev('Bounce', { Type: 'HardBounce' }))
    expect(db.contactUpdates[0].values).toEqual({ email_status: 'bounced' })
  })
  it('a test-send event (no contact_id) never looks up a row', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, { RecordType: 'Open', MessageID: 'pm-t', Metadata: { host_campaign_id: 'hc-1', host_id: 'h-1', test_send: '1' } })
    expect(db.sendSelects).toEqual([])
  })
  it('a failed row write is reported not-ok', async () => {
    const db = stubDb({ sendRow: ROW, failTable: 'host_campaign_sends' })
    expect((await processHostCampaignEvent(db, ev('Delivery'))).ok).toBe(false)
  })
  it('a missing timestamp falls back to now', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Delivery'))
    expect(typeof db.sendUpdates.find((u) => 'delivered_at' in u.values).values.delivered_at).toBe('string')
  })
})
