import { describe, it, expect } from 'vitest'
import { normalizeTrialReturnPath, trialReturnPathFor, parseTrialReturn, TRIAL_RETURN_PATHS } from './trial-return-path'

describe('normalizeTrialReturnPath', () => {
  it('passes the three allowed paths through', () => {
    for (const p of TRIAL_RETURN_PATHS) expect(normalizeTrialReturnPath(p)).toBe(p)
  })
  it('answers /trial for anything else', () => {
    for (const v of ['/Trial', '/stillorgan/', '/hatch-street?x=1', '/hatch-street#trial', '/start', '', null, undefined, 42, 'https://un1tdublin.com/stillorgan'])
      expect(normalizeTrialReturnPath(v)).toBe('/trial')
  })
})
describe('trialReturnPathFor', () => {
  it('maps the two studio paths and falls back to /trial', () => {
    expect(trialReturnPathFor('stillorgan')).toBe('/stillorgan')
    expect(trialReturnPathFor('hatch-street')).toBe('/hatch-street')
    expect(trialReturnPathFor('other')).toBe('/trial')
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
