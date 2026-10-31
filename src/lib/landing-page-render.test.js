// PAGES.1 — the pure helpers behind the one public page route: which layout
// an offer type takes, where a retired page sends its visitors, and what a
// sub-path under a page slug means.
import { describe, it, expect } from 'vitest'
import { layoutFor, redirectTarget, pageSubpath, legacyStudioRedirect } from './landing-page-render.js'

const page = (over = {}) => ({ slug: 'x', kind: 'campaign', offer_type: 'none', redirect_to: null, ...over })

describe('layoutFor', () => {
  it('layoutFor maps the five offer types', () => {
    expect(layoutFor('paid_trial')).toBe('frosted')
    expect(layoutFor('class_funnel')).toBe('frosted')
    expect(layoutFor('promo_credits')).toBe('frosted')
    expect(layoutFor('one_class')).toBe('one_class')
    expect(layoutFor('none')).toBe('blocks')
  })
  it('a studio page is always the blocks layout, whatever its offer type (TRIALFIRST puts the card in its hero)', () => {
    expect(layoutFor('paid_trial', 'studio')).toBe('blocks')
    expect(layoutFor('one_class', 'studio')).toBe('blocks')
    expect(layoutFor('none', 'studio')).toBe('blocks')
    expect(layoutFor('paid_trial', 'campaign')).toBe('frosted')
  })
  it('an unknown or missing type is the plain blocks layout', () => {
    expect(layoutFor('lead_form')).toBe('blocks')
    expect(layoutFor(undefined)).toBe('blocks')
    expect(layoutFor('constructor')).toBe('blocks')
  })
})

describe('redirectTarget', () => {
  const retired = page({ slug: 'start', redirect_to: '/trial?studio=stillorgan' })
  it('redirectTarget keeps the query and, with no studio mapper, drops the sub-path: /start/hatch-street?utm_campaign=x → /trial?studio=stillorgan&utm_campaign=x', () => {
    expect(redirectTarget(retired, ['hatch-street'], { utm_campaign: 'x' })).toBe('/trial?studio=stillorgan&utm_campaign=x')
  })
  it('no query is the target as written; a target with no query takes "?"', () => {
    expect(redirectTarget(retired, undefined, {})).toBe('/trial?studio=stillorgan')
    expect(redirectTarget(page({ redirect_to: '/trial' }), [], { utm_source: 'fb', fbclid: 'abc' })).toBe('/trial?utm_source=fb&fbclid=abc')
  })
  it('keeps every value of a repeated key, in order, and accepts URLSearchParams', () => {
    expect(redirectTarget(page({ redirect_to: '/trial' }), null, { a: ['1', '2'], b: 'x' })).toBe('/trial?a=1&a=2&b=x')
    expect(redirectTarget(page({ redirect_to: '/trial' }), null, new URLSearchParams('a=1&b=two words'))).toBe('/trial?a=1&b=two+words')
  })
  it('/start/<studio> picks that studio, as the old route did: /start/hatch-street → /trial?studio=hatch-street', () => {
    const toPath = (seg) => ({ 'hatch-street': 'hatch-street', hatch: 'hatch-street', stillorgan: 'stillorgan' }[seg] || null)
    expect(redirectTarget(retired, ['hatch-street'], { utm_campaign: 'x' }, { studioFromSegment: toPath }))
      .toBe('/trial?studio=hatch-street&utm_campaign=x')
    expect(redirectTarget(retired, ['hatch'], {}, { studioFromSegment: toPath })).toBe('/trial?studio=hatch-street')
    // A segment that is no studio, or more than one segment, keeps the target's own studio.
    expect(redirectTarget(retired, ['nowhere'], {}, { studioFromSegment: toPath })).toBe('/trial?studio=stillorgan')
    expect(redirectTarget(retired, ['hatch-street', 'x'], {}, { studioFromSegment: toPath })).toBe('/trial?studio=stillorgan')
  })
  it('drops an incoming key the target already sets (a second studio would read as an array)', () => {
    expect(redirectTarget(retired, [], { studio: 'hatch', utm_source: 'fb' })).toBe('/trial?studio=stillorgan&utm_source=fb')
    expect(redirectTarget(retired, [], new URLSearchParams('studio=a&studio=b&fbclid=z'))).toBe('/trial?studio=stillorgan&fbclid=z')
    const toPath = (seg) => (seg === 'hatch-street' ? 'hatch-street' : null)
    expect(redirectTarget(retired, ['hatch-street'], { studio: 'stillorgan' }, { studioFromSegment: toPath })).toBe('/trial?studio=hatch-street')
  })
  it('keeps a fragment on the target after the query', () => {
    expect(redirectTarget(page({ redirect_to: '/trial#trial' }), [], { a: '1' })).toBe('/trial?a=1#trial')
  })
  it('a missing, off-site or protocol-relative target is no target (null)', () => {
    expect(redirectTarget(page({ redirect_to: null }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: '' }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: 'https://evil.example/x' }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: '//evil.example/x' }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: '/\\evil.example' }), [], {})).toBeNull()
  })
})

describe('pageSubpath', () => {
  it('pageSubpath: /corp/hatch-3-free is a promo; /50plus/x is unknown; a studio page serves events and status, nothing else', () => {
    expect(pageSubpath(page({ slug: 'corp', offer_type: 'promo_credits' }), ['hatch-3-free'])).toEqual({ kind: 'promo', key: 'hatch-3-free' })
    expect(pageSubpath(page({ slug: '50plus', offer_type: 'one_class' }), ['x'])).toEqual({ kind: 'unknown' })
    const studio = page({ slug: 'stillorgan', kind: 'studio', offer_type: 'paid_trial' })
    expect(pageSubpath(studio, ['events'])).toEqual({ kind: 'events' })
    expect(pageSubpath(studio, ['status'])).toEqual({ kind: 'status' })
    expect(pageSubpath(studio, ['x'])).toEqual({ kind: 'unknown' })
    expect(pageSubpath(studio, ['events', 'x'])).toEqual({ kind: 'unknown' })
    expect(pageSubpath(studio, ['Events'])).toEqual({ kind: 'unknown' })
    // events / status are a studio page's: a campaign page does not serve them.
    expect(pageSubpath(page({ slug: 'january' }), ['events'])).toEqual({ kind: 'unknown' })
    expect(pageSubpath(page({ slug: 'corp', offer_type: 'promo_credits' }), ['status'])).toEqual({ kind: 'promo', key: 'status' })
  })
  it('no sub-path is the root; two segments under a promo page are unknown', () => {
    expect(pageSubpath(page(), undefined)).toEqual({ kind: 'root' })
    expect(pageSubpath(page(), [])).toEqual({ kind: 'root' })
    expect(pageSubpath(page({ offer_type: 'promo_credits' }), ['a', 'b'])).toEqual({ kind: 'unknown' })
    expect(pageSubpath(page({ offer_type: 'promo_credits' }), [''])).toEqual({ kind: 'unknown' })
  })
})

describe('legacyStudioRedirect', () => {
  it('/welcome/<path>[/events|/status] goes to /<path>[/sub] with the query kept verbatim', () => {
    expect(legacyStudioRedirect('stillorgan', null, { utm_source: 'ig', purchase: 'abc' })).toBe('/stillorgan?utm_source=ig&purchase=abc')
    expect(legacyStudioRedirect('hatch-street', 'events', {})).toBe('/hatch-street/events')
    expect(legacyStudioRedirect('hatch-street', 'status', { a: ['1', '2'] })).toBe('/hatch-street/status?a=1&a=2')
    expect(legacyStudioRedirect('stillorgan', null, new URLSearchParams('edit=1&x=%20y'))).toBe('/stillorgan?edit=1&x=+y')
  })
  it('anything that is not a slug is null (the route answers 404, never an off-site redirect)', () => {
    expect(legacyStudioRedirect('//evil.com', null, {})).toBeNull()
    expect(legacyStudioRedirect('/evil', null, {})).toBeNull()
    expect(legacyStudioRedirect('Bad Path', null, {})).toBeNull()
    expect(legacyStudioRedirect(undefined, null, {})).toBeNull()
    expect(legacyStudioRedirect('stillorgan', 'other', {})).toBeNull()
  })
})
