// HOST-CONSENT.1 — host-stream Postmark events land on HOST tables and never
// on contacts.email_marketing. Identified by Metadata.host_campaign_id (every
// host send stamps it), not by stream name — streams are per host.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./host-consent.js', () => ({ revokeHostConsent: vi.fn().mockResolvedValue({ ok: true, changed: true }) }))

import { isHostCampaignEvent, processHostCampaignEvent } from './host-campaign-webhooks.js'
import { revokeHostConsent } from './host-consent.js'

const META = { host_campaign_id: 'hc-1', host_id: 'h-1', contact_id: 'c-1' }

function stubDb() {
  const contactUpdates = []
  return {
    contactUpdates,
    from: (table) => {
      const filters = []
      const chain = {
        update: (values) => { chain._values = values; return chain },
        eq: (c, v) => { filters.push([c, v]); return chain },
        in: (c, v) => { filters.push(['in', c, v]); return chain },
        then: (resolve, reject) => {
          if (table === 'contacts') contactUpdates.push({ values: chain._values, filters })
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        },
      }
      return chain
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
  it('SubscriptionChange SuppressSending=false (reactivation) is a no-op', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'SubscriptionChange', SuppressSending: false, MessageID: 'm', Metadata: META })
    expect(revokeHostConsent).not.toHaveBeenCalled()
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
    const db = stubDb()
    db.from = () => ({ update: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) })
    const r = await processHostCampaignEvent(db, { RecordType: 'Bounce', Type: 'HardBounce', MessageID: 'm', Metadata: META })
    expect(r).toEqual({ ok: false, error: 'boom' })
  })
  it('host event missing host_id/contact_id metadata is acknowledged with nothing written', async () => {
    const db = stubDb()
    const r = await processHostCampaignEvent(db, { RecordType: 'SpamComplaint', MessageID: 'm', Metadata: { host_campaign_id: 'hc-1' } })
    expect(r).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([])
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
})
