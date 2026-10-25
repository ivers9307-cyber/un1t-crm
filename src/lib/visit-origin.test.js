import { describe, it, expect, beforeEach } from 'vitest'
import { rememberVisitOrigin, readVisitOrigin, sanitiseVisitOrigin, visitOriginLabel, VISIT_ORIGIN_KEY } from './visit-origin'

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
