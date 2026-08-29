import { describe, it, expect } from 'vitest'
import {
  LeadSchema, normaliseLead, leadConfigFromBlocks,
  DEFAULT_LEAD_TAG, DEFAULT_LEAD_SOURCE,
  LEAD_CAMPAIGNS, resolveCampaign,
} from './leads'

const valid = {
  first_name: '  Sarah ', email: 'Sarah@Example.com ', phone: '087 123 4567',
  consent: true, public_path: 'hatch-street',
}

describe('LeadSchema', () => {
  it('accepts a valid submission', () => {
    expect(LeadSchema.safeParse(valid).success).toBe(true)
  })
  it('rejects a blank name', () => {
    expect(LeadSchema.safeParse({ ...valid, first_name: '   ' }).success).toBe(false)
  })
  it('rejects a bad email', () => {
    expect(LeadSchema.safeParse({ ...valid, email: 'nope' }).success).toBe(false)
  })
  it('rejects a too-short phone', () => {
    expect(LeadSchema.safeParse({ ...valid, phone: '123' }).success).toBe(false)
  })
  // The three shapes real Hatch Street leads actually typed. The bare
  // no-trunk-zero form and the +353 form both appear in live signups, so a
  // stricter gate must keep accepting them.
  it.each(['0876449676', '871496810', '+353871494721', '087 123 4567'])(
    'accepts the real mobile form %s', (phone) => {
      expect(LeadSchema.safeParse({ ...valid, phone }).success).toBe(true)
    })
  // 2026-08-24→28: a bot posted 71 signups to the hatch-street lead form with
  // random 10-digit non-Irish numbers. The old >=7-digits refine waved every
  // one through; a mobile gate rejects all of them.
  it.each(['9102985384', '5124203409', '2331614872', '4016013375'])(
    'rejects the bot-signup number %s', (phone) => {
      expect(LeadSchema.safeParse({ ...valid, phone }).success).toBe(false)
    })
  it('rejects consent !== true', () => {
    expect(LeadSchema.safeParse({ ...valid, consent: false }).success).toBe(false)
    expect(LeadSchema.safeParse({ ...valid, consent: undefined }).success).toBe(false)
  })
  it('ignores unknown/legacy fields (e.g. a cached pre-honeypot-removal build still sending company)', () => {
    expect(LeadSchema.safeParse({ ...valid, company: 'whatever' }).success).toBe(true)
  })
  it('accepts an optional campaign key', () => {
    expect(LeadSchema.safeParse({ ...valid, campaign: 'stillorgan-free-class' }).success).toBe(true)
  })
})

describe('normaliseLead', () => {
  it('trims name/phone and lowercases email, campaign null when absent', () => {
    expect(normaliseLead(valid)).toEqual({
      firstName: 'Sarah', email: 'sarah@example.com', phone: '087 123 4567', publicPath: 'hatch-street', campaign: null,
    })
  })
  it('trims and passes through a campaign key', () => {
    expect(normaliseLead({ ...valid, campaign: '  stillorgan-free-class ' }).campaign).toBe('stillorgan-free-class')
  })
})

describe('resolveCampaign', () => {
  it('returns the config for a known campaign', () => {
    expect(resolveCampaign('stillorgan-free-class')).toEqual({
      locationPublicPath: 'stillorgan', tag: 'stillorgan-free-trial', leadSource: 'meta_free_trial',
      whatsappTemplate: 'meta_ad_whatsapp_lead',
    })
  })
  it('returns null for an unknown or non-string key', () => {
    expect(resolveCampaign('made-up')).toBeNull()
    expect(resolveCampaign(null)).toBeNull()
    expect(resolveCampaign(undefined)).toBeNull()
    // not fooled by inherited Object.prototype props
    expect(resolveCampaign('toString')).toBeNull()
    expect(resolveCampaign('constructor')).toBeNull()
  })
  it('every registered campaign carries the three required fields', () => {
    for (const cfg of Object.values(LEAD_CAMPAIGNS)) {
      expect(typeof cfg.locationPublicPath).toBe('string')
      expect(typeof cfg.tag).toBe('string')
      expect(typeof cfg.leadSource).toBe('string')
    }
  })
})

describe('leadConfigFromBlocks', () => {
  it('falls back to defaults when no lead_form block exists', () => {
    expect(leadConfigFromBlocks([{ type: 'hero' }])).toEqual({ tag: DEFAULT_LEAD_TAG, leadSource: DEFAULT_LEAD_SOURCE })
    expect(leadConfigFromBlocks(null)).toEqual({ tag: DEFAULT_LEAD_TAG, leadSource: DEFAULT_LEAD_SOURCE })
  })
  it('uses the block tag/lead_source when present', () => {
    const blocks = [{ type: 'lead_form', tag: 'vip-list', lead_source: 'spring_promo' }]
    expect(leadConfigFromBlocks(blocks)).toEqual({ tag: 'vip-list', leadSource: 'spring_promo' })
  })
  it('falls back when the block fields are blank', () => {
    const blocks = [{ type: 'lead_form', tag: '  ', lead_source: '' }]
    expect(leadConfigFromBlocks(blocks)).toEqual({ tag: DEFAULT_LEAD_TAG, leadSource: DEFAULT_LEAD_SOURCE })
  })
})
