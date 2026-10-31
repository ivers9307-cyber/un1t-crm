import { describe, it, expect } from 'vitest'
import { normalizeTrialReturnPath, trialReturnPathFor, trialReturnPaths, parseTrialReturn } from './trial-return-path'

const SLUGS = ['stillorgan', 'hatch-street', 'dundrum']

describe('trialReturnPaths', () => {
  it('is /trial plus /<slug> of each studio page, once each', () => {
    expect(trialReturnPaths(SLUGS)).toEqual(['/trial', '/stillorgan', '/hatch-street', '/dundrum'])
    expect(trialReturnPaths(['stillorgan', 'stillorgan'])).toEqual(['/trial', '/stillorgan'])
  })
  it('is /trial alone with no slugs, a non-list, or a read that failed', () => {
    for (const v of [undefined, null, [], 'stillorgan', 42]) expect(trialReturnPaths(v)).toEqual(['/trial'])
  })
  it('drops a slug that is not a plain page slug (never a redirect that leaves the site)', () => {
    expect(trialReturnPaths(['', '/evil', '//evil.com', 'a/b', 'a.b', 'A', 'x?y', 'ok-slug', null, 5])).toEqual(['/trial', '/ok-slug'])
  })
})

describe('normalizeTrialReturnPath', () => {
  it('passes /trial and the given studio slugs through', () => {
    expect(normalizeTrialReturnPath('/trial')).toBe('/trial')
    expect(normalizeTrialReturnPath('/trial', { slugs: SLUGS })).toBe('/trial')
    for (const slug of SLUGS) expect(normalizeTrialReturnPath(`/${slug}`, { slugs: SLUGS })).toBe(`/${slug}`)
  })
  it('a studio path outside the list is /trial (another org\'s page, a slug the read did not return, a failed read)', () => {
    expect(normalizeTrialReturnPath('/stillorgan')).toBe('/trial')
    expect(normalizeTrialReturnPath('/stillorgan', { slugs: [] })).toBe('/trial')
    expect(normalizeTrialReturnPath('/other-orgs-studio', { slugs: SLUGS })).toBe('/trial')
  })
  it('answers /trial for anything else', () => {
    for (const v of ['/Trial', '/stillorgan/', '/hatch-street?x=1', '/hatch-street#trial', '/start', '', null, undefined, 42, 'https://un1tdublin.com/stillorgan', '//evil.com', 'stillorgan'])
      expect(normalizeTrialReturnPath(v, { slugs: SLUGS })).toBe('/trial')
  })
})
describe('trialReturnPathFor', () => {
  it('is /<slug> for any studio slug and /trial for none', () => {
    expect(trialReturnPathFor('stillorgan')).toBe('/stillorgan')
    expect(trialReturnPathFor('hatch-street')).toBe('/hatch-street')
    expect(trialReturnPathFor('dundrum')).toBe('/dundrum')
    for (const v of [null, undefined, '', 5]) expect(trialReturnPathFor(v)).toBe('/trial')
  })
})
describe('parseTrialReturn', () => {
  it('reads a uuid purchase, a known studio and cancelled=1', () => {
    expect(parseTrialReturn({ purchase: '11111111-1111-1111-1111-111111111111', studio: 'hatch', cancelled: '1' }))
      .toEqual({ resumePurchaseId: '11111111-1111-1111-1111-111111111111', initialStudio: 'hatch', cancelled: true })
  })
  it('drops a non-uuid purchase, an unknown studio and a missing cancelled', () => {
    expect(parseTrialReturn({ purchase: 'abc', studio: 'HATCH' })).toEqual({ resumePurchaseId: null, initialStudio: null, cancelled: false })
    expect(parseTrialReturn(undefined)).toEqual({ resumePurchaseId: null, initialStudio: null, cancelled: false })
  })
})
