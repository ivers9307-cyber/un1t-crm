// PAGES.1 — the page editor's save helpers.
import { describe, it, expect } from 'vitest'
import {
  storedChrome, termsForSave, pageEditSnapshot, pageSaveMessage, pageSaveBody, studioRowSaveBody, logoWidthForSave,
} from './page-save'

describe('page-save', () => {
  it('storedChrome keeps the schema keys and drops was_live and anything unknown', () => {
    expect(storedChrome({ logo_url: 'https://x/l.png', tone: 'dark', was_live: true, legacy_thing: 1, un1t_terms: { terms_label: 'x' } }))
      .toEqual({ logo_url: 'https://x/l.png', tone: 'dark', un1t_terms: { terms_label: 'x' } })
    expect(storedChrome(null)).toEqual({})
  })

  it('termsForSave trims each field and sends blank as null', () => {
    expect(termsForSave({ terms_label: '  I accept  ', waiver_link_label: ' ' })).toEqual({
      terms_label: 'I accept', terms_link_label: null, waiver_link_label: null,
      terms_required_message: null, legal_unavailable_message: null,
    })
  })

  it('a snapshot changes with any saved field', () => {
    const base = { title: 'A', blocks: [], logoUrl: '', logoAlt: '', logoWidthPx: '', showInstagramFeed: true, terms: {} }
    expect(pageEditSnapshot(base)).toBe(pageEditSnapshot({ ...base }))
    expect(pageEditSnapshot({ ...base, logoAlt: 'x' })).not.toBe(pageEditSnapshot(base))
  })

  it('a refused save names the first invalid field, else the code in words', () => {
    expect(pageSaveMessage({ error: 'Invalid request body', issues: [{ path: 'chrome.logo_alt', message: 'too long' }] }, 400))
      .toBe('Invalid value for chrome.logo_alt')
    expect(pageSaveMessage({ error: 'offer_block_required' }, 400)).toBe('This page\'s offer section is missing, so it cannot be saved. Ask the team.')
    expect(pageSaveMessage({ error: 'studio_page' }, 400)).toBe('A studio page keeps its path: it is the studio\'s address.')
    expect(pageSaveMessage({}, 500)).toBe('Save failed (500)')
  })

  it('logoWidthForSave reads a whole number and clamps it to 40-600', () => {
    expect(logoWidthForSave('180')).toBe(180)
    expect(logoWidthForSave('10')).toBe(40)
    expect(logoWidthForSave('')).toBeNull()
    expect(logoWidthForSave('wide')).toBeNull()
  })

  it('pageSaveBody sends the terms copy on a studio page only, and never was_live', () => {
    const state = { title: ' Hatch ', blocks: [], logoUrl: '', logoAlt: '', logoWidthPx: '', showInstagramFeed: false, terms: { terms_label: 'x' } }
    const studio = pageSaveBody({ ...state, page: { kind: 'studio', chrome: { was_live: true, tone: 'dark' } } })
    expect(studio).toEqual({
      title: 'Hatch',
      blocks: [],
      chrome: {
        tone: 'dark', logo_url: null, logo_alt: null, logo_width_px: null, show_instagram_feed: false,
        un1t_terms: { terms_label: 'x', terms_link_label: null, waiver_link_label: null, terms_required_message: null, legal_unavailable_message: null },
      },
    })
    expect(pageSaveBody({ ...state, page: { kind: 'campaign', chrome: {} } }).chrome).not.toHaveProperty('un1t_terms')
  })

  it('studioRowSaveBody keeps a stored Meta page URL and drops blank attribution', () => {
    expect(studioRowSaveBody({ enabled: 1, offer: null, attribution: { tag: '', lead_source: ' meta ' }, storedAttribution: { event_source_url: 'https://x/y' } }))
      .toEqual({ enabled: true, offer: {}, attribution: { lead_source: 'meta', event_source_url: 'https://x/y' } })
  })
})
