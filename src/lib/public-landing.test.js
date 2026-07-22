import { describe, it, expect } from 'vitest'
import { resolveLandingPath, classFunnelConfigFromBlocks } from './public-landing'

describe('resolveLandingPath', () => {
  it('defaults to stillorgan when the param is absent', () => {
    expect(resolveLandingPath(null)).toBe('stillorgan')
    expect(resolveLandingPath(undefined)).toBe('stillorgan')
  })

  it('defaults to stillorgan for an empty/whitespace param', () => {
    expect(resolveLandingPath('')).toBe('stillorgan')
    expect(resolveLandingPath('   ')).toBe('stillorgan')
  })

  it('trims and lowercases a provided path', () => {
    expect(resolveLandingPath('  Hatch-Street ')).toBe('hatch-street')
  })

  it('passes a normal slug through unchanged', () => {
    expect(resolveLandingPath('stillorgan')).toBe('stillorgan')
  })

  it('strips characters outside the slug charset and caps length', () => {
    expect(resolveLandingPath('bad/../path')).toBe('badpath')
    expect(resolveLandingPath('a'.repeat(200))).toHaveLength(64)
  })

  it('falls back to stillorgan if sanitising empties the string', () => {
    expect(resolveLandingPath('/// ')).toBe('stillorgan')
  })
})

describe('classFunnelConfigFromBlocks', () => {
  // Byte-for-byte parity with the pre-follow-up hard-coded literals: today the
  // Stillorgan /start funnel resolves to path='stillorgan' and its landing page
  // carries no class_funnel block, so all three fall through to defaults.
  it('reproduces the live Stillorgan values when no class_funnel block exists', () => {
    expect(classFunnelConfigFromBlocks(null, 'stillorgan')).toEqual({
      tag: 'stillorgan-start',
      leadSource: 'meta_book',
      eventSourceUrl: 'https://www.un1tdublin.com/start',
      trialMembershipId: null,
      trialPlanCode: null,
      priceCents: 0,
      currency: 'EUR',
    })
    // A page with other block types but no class_funnel → same defaults.
    expect(classFunnelConfigFromBlocks([{ type: 'hero' }, { type: 'lead_form', tag: 'x' }], 'stillorgan'))
      .toEqual({ tag: 'stillorgan-start', leadSource: 'meta_book', eventSourceUrl: 'https://www.un1tdublin.com/start', trialMembershipId: null, trialPlanCode: null, priceCents: 0, currency: 'EUR' })
  })

  it('derives location-specific defaults for a non-Stillorgan path (never mistagged as stillorgan)', () => {
    expect(classFunnelConfigFromBlocks([{ type: 'class_funnel' }], 'blackrock')).toEqual({
      tag: 'blackrock-start',
      leadSource: 'meta_book',
      eventSourceUrl: 'https://www.un1tdublin.com/blackrock',
      trialMembershipId: null,
      trialPlanCode: null,
      priceCents: 0,
      currency: 'EUR',
    })
  })

  it('honours explicit tag / lead_source / event_source_url overrides on the block', () => {
    const blocks = [{
      type: 'class_funnel',
      tag: 'blackrock-vip',
      lead_source: 'meta_vip',
      event_source_url: 'https://blackrock.example.com/join',
    }]
    expect(classFunnelConfigFromBlocks(blocks, 'blackrock')).toEqual({
      tag: 'blackrock-vip',
      leadSource: 'meta_vip',
      eventSourceUrl: 'https://blackrock.example.com/join',
      trialMembershipId: null,
      trialPlanCode: null,
      priceCents: 0,
      currency: 'EUR',
    })
  })

  it('ignores blank/whitespace overrides and falls back to derived defaults', () => {
    const blocks = [{ type: 'class_funnel', tag: '  ', lead_source: '', event_source_url: '   ' }]
    expect(classFunnelConfigFromBlocks(blocks, 'blackrock')).toEqual({
      tag: 'blackrock-start',
      leadSource: 'meta_book',
      eventSourceUrl: 'https://www.un1tdublin.com/blackrock',
      trialMembershipId: null,
      trialPlanCode: null,
      priceCents: 0,
      currency: 'EUR',
    })
  })

  it('re-resolves the landing path (defaults to stillorgan) so a bad path is safe', () => {
    expect(classFunnelConfigFromBlocks([], null)).toEqual({
      tag: 'stillorgan-start',
      leadSource: 'meta_book',
      eventSourceUrl: 'https://www.un1tdublin.com/start',
      trialMembershipId: null,
      trialPlanCode: null,
      priceCents: 0,
      currency: 'EUR',
    })
  })
})

describe('classFunnelConfigFromBlocks — trial product', () => {
  const withBlock = (extra) => [{ id: 'b1', type: 'class_funnel', ...extra }]

  it('returns both trial ids when both are set on the block', () => {
    const r = classFunnelConfigFromBlocks(withBlock({ trial_membership_id: 'm1', trial_plan_code: 'p1' }), 'stillorgan')
    expect(r.trialMembershipId).toBe('m1')
    expect(r.trialPlanCode).toBe('p1')
  })

  it('returns nulls when neither is set (use location default)', () => {
    const r = classFunnelConfigFromBlocks(withBlock({}), 'stillorgan')
    expect(r.trialMembershipId).toBeNull()
    expect(r.trialPlanCode).toBeNull()
  })

  it('returns nulls when only one of the pair is set (half-configured guard)', () => {
    const r1 = classFunnelConfigFromBlocks(withBlock({ trial_membership_id: 'm1' }), 'stillorgan')
    expect(r1.trialMembershipId).toBeNull()
    expect(r1.trialPlanCode).toBeNull()
    const r2 = classFunnelConfigFromBlocks(withBlock({ trial_plan_code: 'p1' }), 'stillorgan')
    expect(r2.trialMembershipId).toBeNull()
    expect(r2.trialPlanCode).toBeNull()
  })

  it('trims whitespace-only trial values to null', () => {
    const r = classFunnelConfigFromBlocks(withBlock({ trial_membership_id: '  ', trial_plan_code: 'p1' }), 'stillorgan')
    expect(r.trialMembershipId).toBeNull()
    expect(r.trialPlanCode).toBeNull()
  })

  it('still returns the existing tag/leadSource/eventSourceUrl fields', () => {
    const r = classFunnelConfigFromBlocks([], 'stillorgan')
    expect(r.tag).toBe('stillorgan-start')
    expect(r.leadSource).toBe('meta_book')
    expect(r.eventSourceUrl).toBe('https://www.un1tdublin.com/start')
    expect(r.trialMembershipId).toBeNull()
    expect(r.trialPlanCode).toBeNull()
  })
})

describe('classFunnelConfigFromBlocks — price', () => {
  const withBlock = (extra) => [{ id: 'b1', type: 'class_funnel', ...extra }]
  it('returns priceCents + currency from the block', () => {
    const r = classFunnelConfigFromBlocks(withBlock({ price_cents: 2900, currency: 'EUR' }), 'stillorgan')
    expect(r.priceCents).toBe(2900)
    expect(r.currency).toBe('EUR')
  })
  it('defaults to 0 / EUR when unset or non-numeric', () => {
    expect(classFunnelConfigFromBlocks(withBlock({}), 'stillorgan').priceCents).toBe(0)
    expect(classFunnelConfigFromBlocks(withBlock({ price_cents: 'x' }), 'stillorgan').priceCents).toBe(0)
    expect(classFunnelConfigFromBlocks(withBlock({}), 'stillorgan').currency).toBe('EUR')
  })
  it('clamps a negative price to 0', () => {
    expect(classFunnelConfigFromBlocks(withBlock({ price_cents: -5 }), 'stillorgan').priceCents).toBe(0)
  })
})
