// PAGES.1 — the pure helpers behind the one public page route: which layout
// an offer type takes, where a retired page sends its visitors, and what a
// sub-path under a page slug means.
import { describe, it, expect } from 'vitest'
import { layoutFor, redirectTarget, pageSubpath } from './landing-page-render.js'

const page = (over = {}) => ({ slug: 'x', kind: 'campaign', offer_type: 'none', redirect_to: null, ...over })

describe('layoutFor', () => {
  it('layoutFor maps the five offer types', () => {
    expect(layoutFor('paid_trial')).toBe('frosted')
    expect(layoutFor('class_funnel')).toBe('frosted')
    expect(layoutFor('promo_credits')).toBe('frosted')
    expect(layoutFor('one_class')).toBe('one_class')
    expect(layoutFor('none')).toBe('blocks')
  })
  it('an unknown or missing type is the plain blocks layout', () => {
    expect(layoutFor('lead_form')).toBe('blocks')
    expect(layoutFor(undefined)).toBe('blocks')
    expect(layoutFor('constructor')).toBe('blocks')
  })
})

describe('redirectTarget', () => {
  const retired = page({ slug: 'start', redirect_to: '/trial?studio=stillorgan' })
  it('redirectTarget keeps the query and drops the sub-path: /start/hatch-street?utm_campaign=x → /trial?studio=stillorgan&utm_campaign=x', () => {
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
  it('a missing, off-site or protocol-relative target is no target (null)', () => {
    expect(redirectTarget(page({ redirect_to: null }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: '' }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: 'https://evil.example/x' }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: '//evil.example/x' }), [], {})).toBeNull()
    expect(redirectTarget(page({ redirect_to: '/\\evil.example' }), [], {})).toBeNull()
  })
})

describe('pageSubpath', () => {
  it('pageSubpath: /corp/hatch-3-free is a promo; /50plus/x is unknown; /stillorgan/events is unknown in PR1', () => {
    expect(pageSubpath(page({ slug: 'corp', offer_type: 'promo_credits' }), ['hatch-3-free'])).toEqual({ kind: 'promo', key: 'hatch-3-free' })
    expect(pageSubpath(page({ slug: '50plus', offer_type: 'one_class' }), ['x'])).toEqual({ kind: 'unknown' })
    expect(pageSubpath(page({ slug: 'stillorgan', kind: 'studio', offer_type: 'paid_trial' }), ['events'])).toEqual({ kind: 'unknown' })
    expect(pageSubpath(page({ slug: 'stillorgan', kind: 'studio', offer_type: 'paid_trial' }), ['status'])).toEqual({ kind: 'unknown' })
  })
  it('no sub-path is the root; two segments under a promo page are unknown', () => {
    expect(pageSubpath(page(), undefined)).toEqual({ kind: 'root' })
    expect(pageSubpath(page(), [])).toEqual({ kind: 'root' })
    expect(pageSubpath(page({ offer_type: 'promo_credits' }), ['a', 'b'])).toEqual({ kind: 'unknown' })
    expect(pageSubpath(page({ offer_type: 'promo_credits' }), [''])).toEqual({ kind: 'unknown' })
  })
})
