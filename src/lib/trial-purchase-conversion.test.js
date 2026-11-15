// HATCHTRACK.1 — the paid trial's server Purchase and the browser details it
// carries: what is stored, what is sent, and when it comes off the row.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ capi: vi.fn(), warn: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: mocks.capi }))
vi.mock('@/lib/log', () => ({ logWarn: mocks.warn, logError: vi.fn() }))

import {
  TRIAL_CLIENT_DATA_KEYS, clientDataForAttribution, withoutClientData, inheritAttribution,
  trialPurchaseConversionArgs, sendTrialPurchaseConversion, clientDataRemoval,
} from './trial-purchase-conversion'

const ROW = {
  id: 'tp1', location_id: 'loc2', contact_id: 'c1', customer_email: 'ava@example.com', customer_phone: '+353851234567',
  first_name: 'Ava', last_name: 'Byrne', product_name: 'The UN1T Trial', amount_cents: 3900, currency: 'EUR',
  attribution: { fbc: 'fb.1.1.CLICK', fbp: 'fb.1.2.3', event_source_url: 'https://www.un1tdublin.com/trial', utm_campaign: 'reset', client_ip: '203.0.113.9', client_user_agent: 'Mozilla/5.0 Test' },
}

function makeDb({ error = null, throws = false } = {}) { // records any write: there must be none
  const updates = []
  return {
    updates,
    from: (table) => ({
      update: (fields) => ({
        eq: async (col, val) => {
          if (throws) throw new Error('network')
          updates.push({ table, fields, col, val })
          return { error }
        },
      }),
    }),
  }
}

beforeEach(() => { vi.clearAllMocks(); mocks.capi.mockResolvedValue({ sent: true }) })

describe('clientDataForAttribution', () => {
  it('keeps the IP address and the user agent (cut to 512), and nothing else', () => {
    expect(clientDataForAttribution({ ip: '203.0.113.9', userAgent: '  Mozilla/5.0  ', extra: 'x' })).toEqual({ client_ip: '203.0.113.9', client_user_agent: 'Mozilla/5.0' })
    expect(clientDataForAttribution({ ip: '2001:db8::1', userAgent: 'a'.repeat(900) }).client_user_agent).toHaveLength(512)
  })
  it('stores nothing for an unknown IP, an absurd one, or a missing user agent', () => {
    for (const ip of ['unknown', '', null, undefined, 42, 'x'.repeat(65)]) expect(clientDataForAttribution({ ip, userAgent: null })).toEqual({})
    expect(clientDataForAttribution({ ip: '203.0.113.9', userAgent: '   ' })).toEqual({ client_ip: '203.0.113.9' })
    expect(clientDataForAttribution()).toEqual({})
  })
  it('the stored keys are exactly the ones removed later', () => {
    expect(Object.keys(clientDataForAttribution({ ip: '203.0.113.9', userAgent: 'UA' })).sort()).toEqual([...TRIAL_CLIENT_DATA_KEYS].sort())
  })
})

describe('withoutClientData', () => {
  it('removes the two keys and keeps the rest; the input is not changed', () => {
    const a = { fbc: 'x', client_ip: '1.1.1.1', client_user_agent: 'UA', meta_schedule_sent_at: 'T' }
    expect(withoutClientData(a)).toEqual({ fbc: 'x', meta_schedule_sent_at: 'T' })
    expect(a.client_ip).toBe('1.1.1.1')
  })
  it('is null when there is nothing to remove (so no write is made)', () => {
    for (const v of [null, undefined, 'x', [], {}, { fbc: 'x' }]) expect(withoutClientData(v)).toBeNull()
  })
})

describe('inheritAttribution', () => {
  it('fills only the first-touch values this attempt lacks', () => {
    expect(inheritAttribution(
      { fbc: undefined, fbp: 'fb.1.new', utm_campaign: '', event_source_url: 'u', client_ip: '1.1.1.1' },
      { fbc: 'fb.1.old', fbp: 'fb.1.old', utm_campaign: 'reset', utm_source: 'ig', ad_provider: 'meta', ad_external_id: 'ad1' },
    )).toEqual({ fbc: 'fb.1.old', fbp: 'fb.1.new', utm_campaign: 'reset', utm_source: 'ig', ad_provider: 'meta', ad_external_id: 'ad1', event_source_url: 'u', client_ip: '1.1.1.1' })
  })
  it("never takes the earlier row's browser details, its stamps or anything that is not a non-empty string", () => {
    const out = inheritAttribution({}, { client_ip: '9.9.9.9', client_user_agent: 'Old', in_app_browser: 'instagram', meta_schedule_sent_at: 'T', event_source_url: 'x', fbc: 42, fbp: '', utm_term: null })
    expect(out).toEqual({})
  })
  it('a missing or malformed earlier attribution changes nothing', () => {
    for (const prior of [null, undefined, 'x', [], 7]) expect(inheritAttribution({ fbp: 'a' }, prior)).toEqual({ fbp: 'a' })
    expect(inheritAttribution(null, { fbc: 'x' })).toEqual({ fbc: 'x' })
  })
})

describe('trialPurchaseConversionArgs', () => {
  it("is the browser Purchase's twin: the same event id, value and order, with the IP, user agent and click ids", () => {
    expect(trialPurchaseConversionArgs(ROW)).toEqual({
      locationId: 'loc2', eventName: 'Purchase',
      email: 'ava@example.com', phone: '+353851234567', firstName: 'Ava', lastName: 'Byrne',
      externalId: 'c1', eventSourceUrl: 'https://www.un1tdublin.com/trial',
      eventId: 'trialpurchase-tp1', contentName: 'The UN1T Trial',
      value: 39, currency: 'EUR', orderId: 'tp1', contentType: 'product',
      fbc: 'fb.1.1.CLICK', fbp: 'fb.1.2.3', clientIp: '203.0.113.9', userAgent: 'Mozilla/5.0 Test',
    })
  })
  it('a row with no attribution still makes a Purchase (hashed identifiers only)', () => {
    const args = trialPurchaseConversionArgs({ ...ROW, attribution: null, currency: null, amount_cents: null })
    expect(args).toMatchObject({ eventId: 'trialpurchase-tp1', value: 0, currency: 'EUR' })
    for (const k of ['fbc', 'fbp', 'clientIp', 'userAgent', 'eventSourceUrl']) expect(args[k]).toBeUndefined()
  })
})

describe('sendTrialPurchaseConversion', () => {
  it('sends once from the row it is given and writes nothing', async () => {
    const db = makeDb()
    expect(await sendTrialPurchaseConversion(db, ROW)).toEqual({ sent: true })
    expect(mocks.capi).toHaveBeenCalledTimes(1)
    expect(mocks.capi).toHaveBeenCalledWith(db, trialPurchaseConversionArgs(ROW))
    expect(db.updates).toHaveLength(0)
  })
  it("answers what the send answered, and a throw reaches the caller (each worker's own catch)", async () => {
    mocks.capi.mockResolvedValueOnce({ sent: false, reason: 'no_dataset' })
    expect(await sendTrialPurchaseConversion(makeDb(), ROW)).toEqual({ sent: false, reason: 'no_dataset' })
    mocks.capi.mockRejectedValueOnce(new Error('boom'))
    await expect(sendTrialPurchaseConversion(makeDb(), ROW)).rejects.toThrow('boom')
  })
})

describe('clientDataRemoval', () => {
  it('is the attribution without the two keys, to spread into the stamp that grants or ends the row', () => {
    expect(clientDataRemoval(ROW)).toEqual({ attribution: { fbc: 'fb.1.1.CLICK', fbp: 'fb.1.2.3', event_source_url: 'https://www.un1tdublin.com/trial', utm_campaign: 'reset' } })
  })
  it('adds nothing to the stamp for a row that holds none (no attribution write at all)', () => {
    for (const row of [null, {}, { attribution: null }, { attribution: { fbc: 'x' } }]) expect(clientDataRemoval(row)).toEqual({})
  })
})
