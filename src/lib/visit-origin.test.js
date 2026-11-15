import { describe, it, expect, beforeEach } from 'vitest'
import { rememberVisitOrigin, readVisitOrigin, sanitiseVisitOrigin, visitOriginLabel, VISIT_ORIGIN_KEY, VISIT_ATTRIBUTION_KEY, firstTouchAttribution } from './visit-origin'

describe('sanitiseVisitOrigin (VISIT-ORIGIN.1)', () => {
  it('keeps origin + path of an http(s) referrer and drops its query and fragment', () => {
    expect(sanitiseVisitOrigin({ referrer: 'https://L.Instagram.com/?u=https%3A%2F%2Fx&e=tok#frag', landing_path: '/hatch-street' }))
      .toEqual({ referrer: 'https://l.instagram.com', landing_path: '/hatch-street' })
    expect(sanitiseVisitOrigin({ referrer: 'https://www.google.com/search?q=gym+dublin+2' }).referrer)
      .toBe('https://www.google.com/search')
  })
  it('drops a referrer that is not a web URL', () => {
    expect(sanitiseVisitOrigin({ referrer: 'javascript:alert(1)', landing_path: '/x' })).toEqual({ referrer: null, landing_path: '/x' })
    expect(sanitiseVisitOrigin({ referrer: 'android-app://com.instagram.android', landing_path: '' })).toBeNull()
  })
  it('keeps only an absolute on-site path for landing_path, without query', () => {
    expect(sanitiseVisitOrigin({ landing_path: '/start/hatch-street?utm_campaign=x#start' }).landing_path).toBe('/start/hatch-street')
    expect(sanitiseVisitOrigin({ landing_path: 'https://evil.example/' })).toBeNull()
    expect(sanitiseVisitOrigin({ landing_path: '//evil.example/' })).toBeNull()
  })
  it('caps lengths', () => {
    const long = '/' + 'a'.repeat(500)
    expect(sanitiseVisitOrigin({ landing_path: long }).landing_path.length).toBe(200)
    const r = sanitiseVisitOrigin({ referrer: 'https://x.example/' + 'b'.repeat(500) }).referrer
    expect(r.length).toBe(300)
  })
  it('returns null for nothing usable', () => {
    expect(sanitiseVisitOrigin(null)).toBeNull()
    expect(sanitiseVisitOrigin({})).toBeNull()
    expect(sanitiseVisitOrigin({ referrer: '', landing_path: '' })).toBeNull()
  })
})

describe('visitOriginLabel (VISIT-ORIGIN.1)', () => {
  it('an ad attribution wins and names the ad', () => {
    expect(visitOriginLabel({ ad_provider: 'meta', utm_content: 'why-un1t-city-centre', visit_referrer: 'https://l.facebook.com' })).toBe('Meta ad (why-un1t-city-centre)')
    expect(visitOriginLabel({ ad_provider: 'meta' })).toBe('Meta ad')
  })
  it('names known referrers and keeps the landing page', () => {
    expect(visitOriginLabel({ visit_referrer: 'https://l.instagram.com', visit_landing_path: '/hatch-street' })).toBe('Instagram, landed on /hatch-street')
    expect(visitOriginLabel({ visit_referrer: 'https://www.google.ie/search' })).toBe('Google')
    expect(visitOriginLabel({ visit_referrer: 'https://m.facebook.com' })).toBe('Facebook')
  })
  it('our own site as referrer reads as Website', () => {
    expect(visitOriginLabel({ visit_referrer: 'https://www.un1tdublin.com', visit_landing_path: '/' })).toBe('Website, landed on /')
  })
  it('an unknown referrer shows its host', () => {
    expect(visitOriginLabel({ visit_referrer: 'https://blog.example.org/post' })).toBe('blog.example.org')
  })
  it('no referrer but a landing path reads as a direct link', () => {
    expect(visitOriginLabel({ visit_landing_path: '/start/hatch-street' })).toBe('Direct link to /start/hatch-street')
  })
  it('nothing known is null, never a made-up label', () => {
    expect(visitOriginLabel({})).toBeNull()
    expect(visitOriginLabel(null)).toBeNull()
  })
})

describe('remember/readVisitOrigin in a browser-like environment', () => {
  const store = new Map()
  beforeEach(() => {
    store.clear()
    globalThis.window = {
      location: { pathname: '/hatch-street' },
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, v) },
      },
    }
    globalThis.document = { referrer: 'https://l.instagram.com/' }
  })
  it('stores the first page once and never overwrites it', () => {
    rememberVisitOrigin()
    globalThis.window.location.pathname = '/start/hatch-street'
    globalThis.document.referrer = 'https://www.un1tdublin.com/hatch-street'
    rememberVisitOrigin()
    expect(readVisitOrigin()).toEqual({ referrer: 'https://l.instagram.com/', landing_path: '/hatch-street' })
    expect(store.has(VISIT_ORIGIN_KEY)).toBe(true)
  })
  it('survives a storage that throws', () => {
    globalThis.window.sessionStorage.setItem = () => { throw new Error('quota') }
    expect(() => rememberVisitOrigin()).not.toThrow()
    expect(readVisitOrigin()).toBeNull()
  })
})

// HATCHTRACK.1 — the ad parameters of the visit's first touch, for this tab.
describe('firstTouchAttribution', () => {
  const store = new Map()
  const go = (pathname, search = '') => { globalThis.window.location = { pathname, search } }
  beforeEach(() => {
    store.clear()
    globalThis.window = {
      location: { pathname: '/', search: '' },
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, v) },
      },
    }
    globalThis.document = { referrer: '' }
  })
  const stored = () => JSON.parse(store.get(VISIT_ATTRIBUTION_KEY) || 'null')

  it('remembers what the first page carried and gives it back to a later page that carries nothing', () => {
    expect(firstTouchAttribution({ utm_campaign: 'reset', utm_source: 'ig', fbclid: 'CLICK', meta_ad_id: undefined }))
      .toEqual({ utm_campaign: 'reset', utm_source: 'ig', fbclid: 'CLICK', meta_ad_id: undefined })
    expect(stored()).toEqual({ utm_campaign: 'reset', utm_source: 'ig', fbclid: 'CLICK' })
    // A return from a cancelled checkout: nothing in the URL.
    expect(firstTouchAttribution({ utm_campaign: undefined, fbclid: undefined })).toMatchObject({ utm_campaign: 'reset', utm_source: 'ig', fbclid: 'CLICK' })
  })
  it('first touch stays first, key by key: a later value never replaces one, but fills one the visit lacked', () => {
    firstTouchAttribution({ utm_campaign: 'first' })
    expect(firstTouchAttribution({ utm_campaign: 'second', fbclid: 'LATER' })).toMatchObject({ utm_campaign: 'first', fbclid: 'LATER' })
    expect(stored()).toEqual({ utm_campaign: 'first', fbclid: 'LATER' })
  })
  it('stores only the known ad keys, each cleaned: an unfilled Meta macro, an empty value and anything else are dropped', () => {
    firstTouchAttribution({ utm_campaign: '{{campaign.name}}', utm_term: '', utm_content: 'ad-1', email: 'sam@example.com', purchase: 'x', fbclid: 42 })
    expect(stored()).toEqual({ utm_content: 'ad-1' })
  })
  it('a visit with no ad parameters stores nothing and returns what it was given', () => {
    expect(firstTouchAttribution({ utm_campaign: undefined })).toEqual({ utm_campaign: undefined })
    expect(firstTouchAttribution(undefined)).toEqual({})
    expect(store.has(VISIT_ATTRIBUTION_KEY)).toBe(false)
  })
  it('a storage that throws gives back what the page carried, and never throws', () => {
    globalThis.window.sessionStorage.setItem = () => { throw new Error('quota') }
    globalThis.window.sessionStorage.getItem = () => { throw new Error('denied') }
    expect(firstTouchAttribution({ utm_campaign: 'a', fbclid: 'B' })).toEqual({ utm_campaign: 'a', fbclid: 'B' })
  })
  it('tampered or broken storage is cleaned on the way out, never trusted', () => {
    store.set(VISIT_ATTRIBUTION_KEY, JSON.stringify({ utm_campaign: 'ok', fbclid: '{{fbclid}}', evil: '<script>', utm_term: 'x'.repeat(900) }))
    const out = firstTouchAttribution({})
    expect(out.utm_campaign).toBe('ok')
    expect(out).not.toHaveProperty('fbclid')
    expect(out).not.toHaveProperty('evil')
    expect(out.utm_term).toHaveLength(200)
    store.set(VISIT_ATTRIBUTION_KEY, 'not json')
    expect(firstTouchAttribution({ utm_campaign: 'a' })).toEqual({ utm_campaign: 'a' })
  })
  it('rememberVisitOrigin captures the landing URL\'s ad parameters on any public page (the old ad_id name too)', () => {
    go('/hatch-street', '?utm_campaign=hatch-reset&fbclid=ABC&ad_id=120&purchase=zzz')
    rememberVisitOrigin()
    expect(stored()).toEqual({ utm_campaign: 'hatch-reset', fbclid: 'ABC', meta_ad_id: '120' })
    // The buyer moves to /trial: the later page still has the click id.
    go('/trial', '?studio=hatch')
    rememberVisitOrigin()
    expect(firstTouchAttribution({})).toEqual({ utm_campaign: 'hatch-reset', fbclid: 'ABC', meta_ad_id: '120' })
  })
})
