// IG-LINK.1 — the name-matching guards are the risky part of Instagram
// contact linking (a wrong link puts a stranger's conversation on a member's
// record), so they are covered exhaustively here.
import { describe, it, expect } from 'vitest'
import {
  normalizeName,
  contactNameVariants,
  isAutoLinkableName,
  pickAutoLinkContact,
  rankContactSuggestions,
} from './instagram-contact-link'

const c = (over = {}) => ({ id: 'c1', name: 'Sarah Byrne', first_name: 'Sarah', last_name: 'Byrne', ...over })

describe('normalizeName', () => {
  it('casefolds, strips accents and punctuation, collapses whitespace', () => {
    expect(normalizeName('  Séan   O\'Brien-Murphy ')).toBe('sean o brien murphy')
    expect(normalizeName('SARAH BYRNE')).toBe('sarah byrne')
  })
  it('is empty for nullish/blank', () => {
    expect(normalizeName(null)).toBe('')
    expect(normalizeName(undefined)).toBe('')
    expect(normalizeName('   ')).toBe('')
    expect(normalizeName('💪')).toBe('')
  })
})

describe('contactNameVariants', () => {
  it('offers both the full name and first+last spellings', () => {
    expect(contactNameVariants(c({ name: 'Sarah J Byrne' }))).toEqual(['sarah j byrne', 'sarah byrne'])
  })
  it('tolerates missing pieces', () => {
    expect(contactNameVariants({ name: 'Cher' })).toEqual(['cher'])
    expect(contactNameVariants(null)).toEqual([])
  })
})

describe('isAutoLinkableName', () => {
  it('accepts a real first + last name', () => {
    expect(isAutoLinkableName('Sarah Byrne')).toBe(true)
  })
  it('rejects mononyms and handle-ish junk (too weak to bind an identity)', () => {
    expect(isAutoLinkableName('Dave')).toBe(false)
    expect(isAutoLinkableName('un1tfan92')).toBe(false)
    expect(isAutoLinkableName('')).toBe(false)
    expect(isAutoLinkableName(null)).toBe(false)
    expect(isAutoLinkableName('J B')).toBe(false)      // single letters aren't tokens
  })
})

describe('pickAutoLinkContact', () => {
  it('links when exactly one contact matches the full name', () => {
    const out = pickAutoLinkContact([c(), c({ id: 'c2', name: 'Mark Kelly', first_name: 'Mark', last_name: 'Kelly' })], 'Sarah Byrne')
    expect(out?.id).toBe('c1')
  })
  it('matches on the first+last spelling too', () => {
    const out = pickAutoLinkContact([c({ name: 'Sarah Byrne (Member)' })], 'Sarah Byrne')
    expect(out?.id).toBe('c1')
  })
  it('is accent- and case-insensitive', () => {
    expect(pickAutoLinkContact([c({ name: 'Séan Ó Briain' })], 'sean o briain')?.id).toBe('c1')
  })
  it('REFUSES when two contacts share the name (the accepted-risk case)', () => {
    const dupes = [c(), c({ id: 'c2' })]
    expect(pickAutoLinkContact(dupes, 'Sarah Byrne')).toBe(null)
  })
  it('refuses a weak display name even against a single candidate', () => {
    expect(pickAutoLinkContact([c({ name: 'Dave' })], 'Dave')).toBe(null)
  })
  it('never steals a contact already bound to a DIFFERENT instagram account', () => {
    const bound = [c({ instagram_igsid: 'IG_OTHER' })]
    expect(pickAutoLinkContact(bound, 'Sarah Byrne', 'IG_NEW')).toBe(null)
  })
  it('allows re-linking the SAME instagram account', () => {
    const bound = [c({ instagram_igsid: 'IG_SAME' })]
    expect(pickAutoLinkContact(bound, 'Sarah Byrne', 'IG_SAME')?.id).toBe('c1')
  })
  it('handles empty/missing candidate lists', () => {
    expect(pickAutoLinkContact([], 'Sarah Byrne')).toBe(null)
    expect(pickAutoLinkContact(null, 'Sarah Byrne')).toBe(null)
  })
})

describe('rankContactSuggestions', () => {
  it('puts an exact name match first', () => {
    const out = rankContactSuggestions(
      [c({ id: 'partial', name: 'Sarah Nolan', first_name: 'Sarah', last_name: 'Nolan' }), c()],
      { displayName: 'Sarah Byrne' }
    )
    expect(out[0].contact.id).toBe('c1')
    expect(out[0].score).toBe(100)
  })
  it('scores a handle that matches the contact name', () => {
    const out = rankContactSuggestions([c()], { displayName: '', handle: 'sarahbyrne' })
    expect(out[0].score).toBe(80)
  })
  it('drops non-matches entirely and caps the list', () => {
    const out = rankContactSuggestions(
      [c(), c({ id: 'x', name: 'Zero Overlap', first_name: 'Zero', last_name: 'Overlap' })],
      { displayName: 'Sarah Byrne' },
      1
    )
    expect(out).toHaveLength(1)
    expect(out[0].contact.id).toBe('c1')
  })
  it('returns [] when nothing is offered', () => {
    expect(rankContactSuggestions([], { displayName: 'Sarah Byrne' })).toEqual([])
    expect(rankContactSuggestions(null, {})).toEqual([])
  })
})
