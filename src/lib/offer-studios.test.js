import { describe, it, expect, vi } from 'vitest'
import {
  OFFER_STUDIOS, studioForKey, studioForLocationSlug, resolveOfferStudio,
  offersPageCopy, DEFAULT_OFFERS_PAGE_COPY,
} from './offer-studios'

function dbReturning(result) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => result),
  }
  return { from: vi.fn(() => chain), chain }
}

describe('offer studios', () => {
  it('maps exactly the two studios', () => {
    expect(Object.keys(OFFER_STUDIOS).sort()).toEqual(['hatch-street', 'stillorgan'])
    expect(studioForKey('hatch-street').locationSlug).toBe('un1t-hatch-street')
    expect(studioForKey('stillorgan').locationSlug).toBe('un1t-stillorgan')
    expect(studioForKey('nope')).toBeNull()
    expect(studioForKey('__proto__')).toBeNull()
  })
  it('finds a studio by location slug', () => {
    expect(studioForLocationSlug('un1t-hatch-street').key).toBe('hatch-street')
    expect(studioForLocationSlug('x')).toBeNull()
  })
})

describe('resolveOfferStudio', () => {
  it('null for an unknown key without touching the db', async () => {
    const db = dbReturning({ data: null, error: null })
    expect(await resolveOfferStudio(db, 'nope')).toBeNull()
    expect(db.from).not.toHaveBeenCalled()
  })
  it('selects named columns, never *', async () => {
    const row = { id: 'l1', slug: 'un1t-stillorgan', name: 'UN1T Stillorgan', organization_id: 'o', membership_source: 'glofox', settings: {} }
    const db = dbReturning({ data: row, error: null })
    const r = await resolveOfferStudio(db, 'stillorgan')
    expect(r.location).toEqual(row)
    expect(r.studio.key).toBe('stillorgan')
    const cols = db.chain.select.mock.calls[0][0]
    expect(cols).not.toContain('*')
    expect(cols).toBe('id, slug, name, organization_id, membership_source, settings')
  })
  it('null for a missing row, throws on a db error', async () => {
    expect(await resolveOfferStudio(dbReturning({ data: null, error: null }), 'stillorgan')).toBeNull()
    await expect(resolveOfferStudio(dbReturning({ data: null, error: new Error('boom') }), 'stillorgan')).rejects.toThrow('boom')
  })
})

describe('offersPageCopy', () => {
  it('defaults', () => {
    const c = offersPageCopy({ settings: {} })
    expect(c.line2).toBe('HEAD START')
    expect(c.marquee).toBe('BLACK FRIDAY HEAD START · ')
    expect(c.legalLine).toBe('')
    expect(c.infoBlocks).toHaveLength(3)
    expect(c.infoBlocks[2].title).toBe('Black Friday Open Week')
  })
  it('tolerates a missing location/settings', () => {
    expect(offersPageCopy(null).line1).toBe('BLACK FRIDAY')
    expect(offersPageCopy({}).line1).toBe('BLACK FRIDAY')
  })
  it('overrides per field, keeping other defaults', () => {
    const c = offersPageCopy({ settings: { offers_page: { blurb: 'X' } } })
    expect(c.blurb).toBe('X')
    expect(c.infoBlocks).toEqual(DEFAULT_OFFERS_PAGE_COPY.infoBlocks)
  })
  it('ignores blank or wrong-typed overrides', () => {
    const c = offersPageCopy({ settings: { offers_page: { blurb: '  ', line1: 5, infoBlocks: 'x' } } })
    expect(c.blurb).toBe(DEFAULT_OFFERS_PAGE_COPY.blurb)
    expect(c.line1).toBe('BLACK FRIDAY')
    expect(c.infoBlocks).toEqual(DEFAULT_OFFERS_PAGE_COPY.infoBlocks)
  })
})
