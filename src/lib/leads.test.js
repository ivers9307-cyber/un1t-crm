import { describe, it, expect } from 'vitest'
import {
  LeadSchema, normaliseLead, leadConfigFromBlocks,
  DEFAULT_LEAD_TAG, DEFAULT_LEAD_SOURCE,
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
  it('rejects consent !== true', () => {
    expect(LeadSchema.safeParse({ ...valid, consent: false }).success).toBe(false)
    expect(LeadSchema.safeParse({ ...valid, consent: undefined }).success).toBe(false)
  })
  it('ignores unknown/legacy fields (e.g. a cached pre-honeypot-removal build still sending company)', () => {
    expect(LeadSchema.safeParse({ ...valid, company: 'whatever' }).success).toBe(true)
  })
})

describe('normaliseLead', () => {
  it('trims name/phone and lowercases email', () => {
    expect(normaliseLead(valid)).toEqual({
      firstName: 'Sarah', email: 'sarah@example.com', phone: '087 123 4567', publicPath: 'hatch-street',
    })
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
