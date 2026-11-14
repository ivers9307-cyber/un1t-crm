// FIFTYPLUS.1 — the ad-attribution plumbing a campaign page shares with the
// class funnel, as pure functions: what the landing URL carries, what the
// booking POST sends, and the per-visit session id.
import { describe, it, expect } from 'vitest'
import { readAttributionFromUrl, buildAttribution, funnelSessionId, isUnfilledAdMacro, cleanAdValue, cleanAttribution } from './campaign-funnel-attribution'

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

describe('TRIALLEAK.1 — utm_source / utm_medium', () => {
  it('are read off the URL (ad_id is read as the ad id too)', () => {
    expect(readAttributionFromUrl('?utm_source=facebook&utm_medium=paid&ad_id=77')).toMatchObject({ utm_source: 'facebook', utm_medium: 'paid', meta_ad_id: '77' })
    expect(readAttributionFromUrl('?meta_ad_id=1&ad_id=2').meta_ad_id).toBe('1')
  })
  it('travel with the attribution but never make anyone an ad lead', () => {
    expect(buildAttribution({ utm_source: 'newsletter', utm_medium: 'email' }, null)).toEqual({ utm_source: 'newsletter', utm_medium: 'email' })
    expect(buildAttribution({ utm_source: 'ig', utm_campaign: 'c' }, 'fb.1.2.3')).toEqual({
      utm_campaign: 'c', utm_content: undefined, utm_term: undefined, ad_provider: 'meta', ad_external_id: undefined, fbclid: undefined,
      utm_source: 'ig', fbp: 'fb.1.2.3',
    })
  })
})

describe('TRIALLEAK.1 — unfilled Meta macros', () => {
  it('spots a macro Meta left unfilled, plain or URL-encoded, and nothing else', () => {
    for (const v of ['{{ad.id}}', '{{adset.id}}', '{{campaign.name}}', 'x_{{placement}}_y', '%7B%7Bad.id%7D%7D', '%7b%7badset.id%7d%7d']) expect(isUnfilledAdMacro(v)).toBe(true)
    for (const v of ['120248413617870055', 'META_50plus', 'a{b}c', '{{', '}}{{', '', null, undefined, 12]) expect(isUnfilledAdMacro(v)).toBe(false)
  })
  it('cleanAdValue keeps a real value and drops a macro or nothing', () => {
    expect(cleanAdValue('karl-ad-1')).toBe('karl-ad-1')
    expect(cleanAdValue('{{ad.name}}')).toBeUndefined()
    expect(cleanAdValue('')).toBeUndefined()
    expect(cleanAdValue(null)).toBeUndefined()
  })
  it('the URL reader treats a macro as absent, so an organic view of an ad post is not an ad lead', () => {
    const raw = readAttributionFromUrl('?utm_campaign={{campaign.name}}&utm_content=%7B%7Bad.name%7D%7D&utm_term={{adset.id}}&utm_source={{site_source_name}}&utm_medium=paid&meta_ad_id={{ad.id}}&ad_id={{ad.id}}')
    expect(raw).toEqual({ utm_campaign: undefined, utm_content: undefined, utm_term: undefined, utm_source: undefined, utm_medium: 'paid', meta_ad_id: undefined, fbclid: undefined })
    expect(buildAttribution(raw, null)).toEqual({ utm_medium: 'paid' })
  })
  it('cleanAttribution removes macro values from a posted attribution and leaves the rest', () => {
    expect(cleanAttribution({ utm_campaign: 'c1', utm_term: '{{adset.id}}', ad_external_id: '%7B%7Bad.id%7D%7D', ad_provider: 'meta', fbclid: 'f', fbp: 'fb.1' }))
      .toEqual({ utm_campaign: 'c1', ad_provider: 'meta', fbclid: 'f', fbp: 'fb.1' })
    expect(cleanAttribution(undefined)).toBeUndefined()
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
