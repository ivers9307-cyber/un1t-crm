// PAGES.1 — the page editor's save helpers.
import { describe, it, expect } from 'vitest'
import { storedChrome, termsForSave, pageEditSnapshot, pageSaveMessage } from './page-save'

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
    expect(pageSaveMessage({ error: 'offer_block_required' }, 400)).toBe('The offer section must stay first on this page.')
    expect(pageSaveMessage({}, 500)).toBe('Save failed (500)')
  })
})
