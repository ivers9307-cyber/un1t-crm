import { describe, it, expect, vi } from 'vitest'
import {
  OFFER_STUDIOS, studioForKey, studioForLocationSlug, resolveOfferStudio,
  offersPageCopy, DEFAULT_OFFERS_PAGE_COPY, offerRail, offerPageMode,
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

// BLACKFRIDAY.9 — one payment-rail rule for the handler and the page.
describe('offerRail', () => {
  const un1t = { membership_source: 'un1t_online' }
  const glofox = { membership_source: 'glofox' }
  it('a un1t.online studio membership or pack with a product goes to un1t.online', () => {
    expect(offerRail(un1t, { category: 'membership', un1t_product_id: 'p1' })).toBe('un1t_online')
    expect(offerRail(un1t, { category: 'class_pack', un1t_product_id: 'p2' })).toBe('un1t_online')
  })
  it('that combination without a product id is not configured, never Revolut', () => {
    expect(offerRail(un1t, { category: 'membership', un1t_product_id: null })).toBe('not_configured')
    expect(offerRail(un1t, { category: 'class_pack' })).toBe('not_configured')
    expect(offerRail(un1t, { category: 'membership', un1t_product_id: '  ' })).toBe('not_configured')
  })
  it('a product id outside that combination is not configured, never Revolut', () => {
    expect(offerRail(un1t, { category: 'gift_card', un1t_product_id: 'p3' })).toBe('not_configured')
    expect(offerRail(glofox, { category: 'membership', un1t_product_id: 'p4' })).toBe('not_configured')
    expect(offerRail(null, { category: 'class_pack', un1t_product_id: 'p5' })).toBe('not_configured')
  })
  it('everything else goes to Revolut', () => {
    expect(offerRail(un1t, { category: 'gift_card', un1t_product_id: null })).toBe('revolut')
    expect(offerRail(glofox, { category: 'membership', un1t_product_id: null })).toBe('revolut')
    expect(offerRail(glofox, { category: 'gift_card' })).toBe('revolut')
  })
})

describe('offerPageMode', () => {
  it('a purchase return resumes whatever the window says', () => {
    expect(offerPageMode({ open: false, upcoming: false, purchase: 'p' })).toBe('resume')
    expect(offerPageMode({ open: true, upcoming: false, purchase: 'p' })).toBe('resume')
  })
  it('a cancelled return never resumes: form when open, else the window panel', () => {
    expect(offerPageMode({ open: true, upcoming: false, purchase: 'p', cancelled: true })).toBe('form')
    expect(offerPageMode({ open: false, upcoming: false, purchase: 'p', cancelled: true })).toBe('ended')
    expect(offerPageMode({ open: false, upcoming: true, purchase: 'p', cancelled: true })).toBe('upcoming')
  })
  it('no purchase follows the window', () => {
    expect(offerPageMode({ open: true, upcoming: false })).toBe('form')
    expect(offerPageMode({ open: false, upcoming: true })).toBe('upcoming')
    expect(offerPageMode({ open: false, upcoming: false })).toBe('ended')
  })
})
