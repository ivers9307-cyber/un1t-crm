// FIFTYPLUS.1 — the ad-attribution plumbing a campaign page shares with the
// class funnel, as pure functions: what the landing URL carries, what the
// booking POST sends, and the per-visit session id.
import { describe, it, expect } from 'vitest'
import { readAttributionFromUrl, buildAttribution, funnelSessionId } from './campaign-funnel-attribution'

describe('readAttributionFromUrl', () => {
  it('reads the ad params and leaves the rest undefined', () => {
    expect(readAttributionFromUrl('?utm_campaign=c&utm_content=ct&utm_term=t&meta_ad_id=123&fbclid=f&x=1')).toEqual({
      utm_campaign: 'c', utm_content: 'ct', utm_term: 't', meta_ad_id: '123', fbclid: 'f',
    })
    expect(readAttributionFromUrl('')).toEqual({
      utm_campaign: undefined, utm_content: undefined, utm_term: undefined, meta_ad_id: undefined, fbclid: undefined,
    })
  })
})

describe('buildAttribution', () => {
  it('is undefined with no ad signal and no browser id', () => {
    expect(buildAttribution({}, null)).toBe(undefined)
  })
  it('names meta as the provider when an ad id is present', () => {
    expect(buildAttribution({ meta_ad_id: '123', utm_campaign: 'c', fbclid: 'f' }, null)).toEqual({
      utm_campaign: 'c', utm_content: undefined, utm_term: undefined,
      ad_provider: 'meta', ad_external_id: '123', fbclid: 'f',
    })
  })
  it('sends the browser id alone for an organic visitor', () => {
    expect(buildAttribution({}, 'fb.1.2.3')).toEqual({ fbp: 'fb.1.2.3' })
  })
})

describe('funnelSessionId', () => {
  it('reuses a stored id and mints one when there is none or storage throws', () => {
    const store = new Map()
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    const first = funnelSessionId(storage)
    expect(first).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    expect(funnelSessionId(storage)).toBe(first)
    expect(store.get('campaign_sid')).toBe(first)
    const throwing = { getItem: () => { throw new Error('private') }, setItem: () => { throw new Error('private') } }
    expect(typeof funnelSessionId(throwing)).toBe('string')
  })
})
