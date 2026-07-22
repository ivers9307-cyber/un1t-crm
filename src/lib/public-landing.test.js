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
    })
    // A page with other block types but no class_funnel → same defaults.
    expect(classFunnelConfigFromBlocks([{ type: 'hero' }, { type: 'lead_form', tag: 'x' }], 'stillorgan'))
      .toEqual({ tag: 'stillorgan-start', leadSource: 'meta_book', eventSourceUrl: 'https://www.un1tdublin.com/start' })
  })

  it('derives location-specific defaults for a non-Stillorgan path (never mistagged as stillorgan)', () => {
    expect(classFunnelConfigFromBlocks([{ type: 'class_funnel' }], 'blackrock')).toEqual({
      tag: 'blackrock-start',
      leadSource: 'meta_book',
      eventSourceUrl: 'https://www.un1tdublin.com/blackrock',
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
    })
  })

  it('ignores blank/whitespace overrides and falls back to derived defaults', () => {
    const blocks = [{ type: 'class_funnel', tag: '  ', lead_source: '', event_source_url: '   ' }]
    expect(classFunnelConfigFromBlocks(blocks, 'blackrock')).toEqual({
      tag: 'blackrock-start',
      leadSource: 'meta_book',
      eventSourceUrl: 'https://www.un1tdublin.com/blackrock',
    })
  })

  it('re-resolves the landing path (defaults to stillorgan) so a bad path is safe', () => {
    expect(classFunnelConfigFromBlocks([], null)).toEqual({
      tag: 'stillorgan-start',
      leadSource: 'meta_book',
      eventSourceUrl: 'https://www.un1tdublin.com/start',
    })
  })
})
