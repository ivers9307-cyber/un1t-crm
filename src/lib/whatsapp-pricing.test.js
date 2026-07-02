import { describe, it, expect, vi, afterEach } from 'vitest'
import { pricingColumnsFromStatus, buildPricingAnalyticsUrl, fetchPricingAnalytics } from './whatsapp-pricing.js'

describe('pricingColumnsFromStatus', () => {
  it('maps the PMP pricing object to columns', () => {
    expect(pricingColumnsFromStatus({ pricing: { billable: true, pricing_model: 'PMP', category: 'marketing', type: 'regular' } }))
      .toEqual({ pricing_category: 'marketing', pricing_type: 'regular', billable: true })
  })
  it('captures free utility-in-window sends', () => {
    expect(pricingColumnsFromStatus({ pricing: { billable: false, category: 'utility', type: 'free_customer_service' } }))
      .toEqual({ pricing_category: 'utility', pricing_type: 'free_customer_service', billable: false })
  })
  it('returns null when the status carries no pricing', () => {
    expect(pricingColumnsFromStatus({ status: 'delivered' })).toBeNull()
    expect(pricingColumnsFromStatus(undefined)).toBeNull()
    expect(pricingColumnsFromStatus({ pricing: {} })).toBeNull()
  })
})

describe('buildPricingAnalyticsUrl', () => {
  it('targets the WABA node with COST+VOLUME and category/type dimensions', () => {
    const url = buildPricingAnalyticsUrl({ wabaId: 'waba1', start: 100, end: 200 })
    expect(url).toContain('graph.facebook.com/v21.0/waba1?fields=')
    const field = decodeURIComponent(url.split('fields=')[1])
    expect(field).toContain('pricing_analytics.start(100).end(200).granularity(MONTHLY)')
    expect(field).toContain('[COST,VOLUME]')
    expect(field).toContain('[PRICING_CATEGORY,PRICING_TYPE]')
  })
})

describe('fetchPricingAnalytics', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the pricing_analytics payload on success', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ pricing_analytics: { data: [1] } }) }))
    const out = await fetchPricingAnalytics({ wabaId: 'w', accessToken: 't' }, { start: 1, end: 2 })
    expect(out).toEqual({ data: [1] })
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer t')
  })
  it('missing config → null without fetching', async () => {
    global.fetch = vi.fn()
    expect(await fetchPricingAnalytics({ wabaId: null, accessToken: 't' }, { start: 1, end: 2 })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('API error → null, never throws', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'nope' } }) }))
    expect(await fetchPricingAnalytics({ wabaId: 'w', accessToken: 't' }, { start: 1, end: 2 })).toBeNull()
  })
})
