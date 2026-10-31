// UN1TWRITE.18 — the class_funnel block's un1t.online copy.
import { describe, it, expect } from 'vitest'
import { DEFAULT_FUNNEL_TERMS_COPY, un1tFunnelCopyFromBlocks, un1tFunnelCopyFromTerms, un1tTermsPayload, termsLabelSegments, termsLabelText, fillCopy } from './un1t-online-funnel-copy'

const CAPACITY = /spot|capacity|space|place|seat|full|left|remaining/i

describe('defaults', () => {
  it('carry no em-dash, no capacity word and no brand name', () => {
    for (const [k, v] of Object.entries(DEFAULT_FUNNEL_TERMS_COPY)) {
      expect(v, k).not.toMatch(/[—–]/)
      expect(v, k).not.toMatch(CAPACITY)
      expect(v, k).not.toMatch(/UN1T/)
    }
  })
})

describe('un1tFunnelCopyFromBlocks', () => {
  it('blank fields fall back to defaults; set fields win', () => {
    expect(un1tFunnelCopyFromBlocks(null)).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    const out = un1tFunnelCopyFromBlocks([{ type: 'hero' }, { type: 'class_funnel', terms_label: '  ', terms_required_message: ' Tick it. ' }])
    expect(out.terms_label).toBe(DEFAULT_FUNNEL_TERMS_COPY.terms_label)
    expect(out.terms_required_message).toBe('Tick it.')
  })
})

// PAGES.1 — a studio page keeps the five words on chrome.un1t_terms, a plain
// object rather than a class_funnel block: the same blank-is-default rule.
describe('un1tFunnelCopyFromTerms', () => {
  it('blank or absent keys fall back to defaults; set keys win; junk is all defaults', () => {
    expect(un1tFunnelCopyFromTerms({})).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    expect(un1tFunnelCopyFromTerms(null)).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    expect(un1tFunnelCopyFromTerms('nope')).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    const out = un1tFunnelCopyFromTerms({ terms_label: ' Mine {terms} ', waiver_link_label: '   ', terms_required_message: 7 })
    expect(out).toEqual({ ...DEFAULT_FUNNEL_TERMS_COPY, terms_label: 'Mine {terms}' })
  })

  it('un1tTermsPayload takes the terms object beside the blocks form, with the same output', () => {
    const terms = { terms_label: 'CUSTOM {studio_name} {terms}', terms_link_label: 'the rules' }
    const fromTerms = un1tTermsPayload({ terms, studioName: 'Hatch Street', publicPath: 'hatch-street' })
    const fromBlocks = un1tTermsPayload({ blocks: [{ type: 'class_funnel', ...terms }], studioName: 'Hatch Street', publicPath: 'hatch-street' })
    expect(fromTerms).toEqual(fromBlocks)
    expect(fromTerms).toMatchObject({ required: true, label: 'CUSTOM Hatch Street {terms}', terms_link_label: 'the rules', terms_url: '/legal/un1t/hatch-street/terms', waiver_url: '/legal/un1t/hatch-street/waiver' })
    expect(un1tTermsPayload({ terms: {}, studioName: '', publicPath: 'x' }).label).toBe("I accept the studio's {terms} and {waiver}")
  })
})

describe('termsLabelSegments', () => {
  it('renders {terms} and {waiver} as the two links and fills the studio name', () => {
    const segs = termsLabelSegments(DEFAULT_FUNNEL_TERMS_COPY, { studioName: 'Hatch Street' })
    expect(segs).toEqual([
      { text: "I accept Hatch Street's " },
      { text: 'terms and conditions', link: 'terms' },
      { text: ' and ' },
      { text: 'liability waiver', link: 'waiver' },
    ])
    expect(termsLabelText(DEFAULT_FUNNEL_TERMS_COPY, { studioName: 'Hatch Street' })).toBe("I accept Hatch Street's terms and conditions and liability waiver")
  })

  it('a label missing a link gets it appended, and em-dashes are stripped', () => {
    const segs = termsLabelSegments({ ...DEFAULT_FUNNEL_TERMS_COPY, terms_label: 'Yes — I agree to the {waiver}' }, { studioName: 'X' })
    expect(segs.filter((s) => s.link).map((s) => s.link)).toEqual(['waiver', 'terms'])
    expect(segs.map((s) => s.text).join('')).not.toMatch(/[—–]/)
  })
})

describe('fillCopy', () => {
  it('fills, strips dashes and renders unknown placeholders empty', () => {
    expect(fillCopy('Hi {first_name} — {nope}at {studio_name}', { first_name: 'Sam', studio_name: 'Hatch' })).toBe('Hi Sam, at Hatch')
  })
})

describe('stripDashes', () => {
  it('matches the agent scrub (the browser cannot import it)', async () => {
    const { stripEmDashes } = await import('./agent/core')
    const { stripDashes } = await import('./un1t-online-funnel-copy')
    for (const s of ['a — b', 'a—b', '5:00–5:30', 'x –y', 'plain']) expect(stripDashes(s)).toBe(stripEmDashes(s))
  })

  it('a studio with no name still reads as a sentence', () => {
    expect(termsLabelText(DEFAULT_FUNNEL_TERMS_COPY, { studioName: '' })).toBe("I accept the studio's terms and conditions and liability waiver")
  })
})
