import { describe, it, expect } from 'vitest'
import { heroFor, storefrontTitle, CATEGORY_ORDER, storefrontOffers, storefrontCountdown, isCyberMondayOnly } from './offers-storefront'
import { OFFER_SALE_TAG } from './sale-offers'

const gift = { category: 'gift_card' }
const pack = { category: 'class_pack' }
const membership = { category: 'membership' }

describe('offers storefront copy (OFFERS.8)', () => {
  it('a gift-card-only storefront gets gift copy', () => {
    const h = heroFor([gift, gift])
    expect(h.line2).toBe('OF TRAINING')
    expect(h.marquee).toMatch(/GIFT CARDS/)
  })

  const copy = { marquee: 'M · ', line1: 'L1', line2: 'L2', blurb: 'B' }

  it('gift-only keeps the gift hero, with the studio in the title', () => {
    expect(heroFor([gift], copy).line1).toBe('GIVE THE GIFT')
    expect(heroFor([gift], copy, 'UN1T Hatch Street').title).toBe('Gift Cards — UN1T Hatch Street')
  })

  it('any timed sale reads from the studio copy', () => {
    const h = heroFor([gift, pack, pack], copy, 'UN1T Hatch Street')
    expect(h).toEqual({ marquee: 'M · ', line1: 'L1', line2: 'L2', blurb: 'B', title: 'Black Friday — UN1T Hatch Street' })
    expect(heroFor([pack], copy).line2).toBe(copy.line2)
    expect(heroFor([membership], copy).line2).toBe(copy.line2)
  })

  it('copy is optional and defaults to the Black Friday head start', () => {
    expect(heroFor([membership]).line2).toBe('HEAD START')
    expect(heroFor([]).line2).toBe('HEAD START')
  })

  it('the tab title follows the same rule', () => {
    expect(storefrontTitle(new Set(['gift_card']))).toBe('Gift Cards — UN1T Stillorgan')
    expect(storefrontTitle(new Set(['gift_card', 'class_pack']))).toBe('Black Friday — UN1T Stillorgan')
    expect(storefrontTitle(new Set(), 'UN1T Hatch Street')).toBe('Black Friday — UN1T Hatch Street')
  })

  it('timed sale sections render ahead of the evergreen gift cards', () => {
    expect(CATEGORY_ORDER).toEqual(['membership', 'class_pack', 'gift_card'])
  })

  it('a Black Friday buyer is tagged for the Black Friday sale', () => {
    expect(OFFER_SALE_TAG).toBe('offer-sale-bf-2026')
  })
})

describe('storefront decisions (BLACKFRIDAY.3)', () => {
  // The head start: memberships and packs open 23 Nov, the gift drop on
  // Cyber Monday 30 Nov; the sale closes 30 Nov 23:59 (UTC == Dublin in Nov).
  const MEMBERSHIP = { id: 'm', active: true, category: 'membership', starts_at: '2026-11-23T00:00:00Z', ends_at: '2026-11-30T23:59:00Z' }
  const PACK = { id: 'p', active: true, category: 'class_pack', starts_at: '2026-11-23T00:00:00Z', ends_at: '2026-11-29T23:59:00Z' }
  const CYBER_GIFT = { id: 'g', active: true, category: 'gift_card', starts_at: '2026-11-30T00:00:00Z', ends_at: null }
  const EVERGREEN_GIFT = { id: 'e', active: true, category: 'gift_card', starts_at: '2026-01-01T00:00:00Z', ends_at: null }
  const INACTIVE = { id: 'x', active: false, category: 'membership', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-20T00:00:00Z' }
  const NULL_START = { id: 'n', active: true, category: 'membership', starts_at: null, ends_at: null }
  const ENDED = { id: 'd', active: true, category: 'class_pack', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-10T00:00:00Z' }
  const BEFORE = new Date('2026-11-15T12:00:00Z')
  const DURING = new Date('2026-11-25T12:00:00Z')

  it('lists open and upcoming rows, keeps their order, drops inactive and ended ones', () => {
    const rows = [MEMBERSHIP, INACTIVE, EVERGREEN_GIFT, ENDED, CYBER_GIFT]
    expect(storefrontOffers(rows, BEFORE).map((o) => o.id)).toEqual(['m', 'e', 'g'])
    expect(storefrontOffers(rows, DURING).map((o) => o.id)).toEqual(['m', 'e', 'g'])
    expect(storefrontOffers(null, DURING)).toEqual([])
  })

  it('before 23 Nov the countdown is "Opens" against the membership starts_at', () => {
    const listed = storefrontOffers([MEMBERSHIP, PACK, CYBER_GIFT, EVERGREEN_GIFT], BEFORE)
    expect(storefrontCountdown(listed, BEFORE)).toEqual({ label: 'Opens', at: MEMBERSHIP.starts_at, doneLabel: 'NOW OPEN' })
  })

  it('during the week the countdown is "Sale ends" against the earliest ends_at', () => {
    const listed = storefrontOffers([MEMBERSHIP, PACK, CYBER_GIFT], DURING)
    expect(storefrontCountdown(listed, DURING)).toEqual({ label: 'Sale ends', at: PACK.ends_at, doneLabel: 'SALE ENDED' })
  })

  it('an evergreen gift card alone drives no countdown', () => {
    expect(storefrontCountdown([EVERGREEN_GIFT], DURING)).toBeNull()
    expect(storefrontCountdown([], DURING)).toBeNull()
  })

  it('ignores an inactive row even if it is handed in', () => {
    const early = { ...MEMBERSHIP, id: 'i', active: false, ends_at: '2026-11-24T00:00:00Z' }
    expect(storefrontCountdown([early, MEMBERSHIP], DURING).at).toBe(MEMBERSHIP.ends_at)
  })

  it('a NULL starts_at row neither crashes nor skews the countdown', () => {
    expect(storefrontCountdown([NULL_START, MEMBERSHIP], BEFORE)).toEqual({ label: 'Opens', at: MEMBERSHIP.starts_at, doneLabel: 'NOW OPEN' })
    expect(storefrontCountdown([MEMBERSHIP, NULL_START], DURING).at).toBe(MEMBERSHIP.ends_at)
    const upcomingNull = { ...CYBER_GIFT, starts_at: null }
    expect(() => storefrontCountdown([upcomingNull], BEFORE)).not.toThrow()
  })

  it('flags a gift row that opens after the memberships as Cyber Monday only', () => {
    const listed = [MEMBERSHIP, CYBER_GIFT, EVERGREEN_GIFT]
    expect(isCyberMondayOnly(CYBER_GIFT, listed)).toBe(true)
    expect(isCyberMondayOnly(EVERGREEN_GIFT, listed)).toBe(false)
    expect(isCyberMondayOnly(MEMBERSHIP, listed)).toBe(false)
  })

  it('no membership listed means no Cyber Monday flag', () => {
    expect(isCyberMondayOnly(CYBER_GIFT, [CYBER_GIFT, PACK])).toBe(false)
  })

  it('a NULL starts_at neither crashes nor skews the flag', () => {
    // The NULL membership must not stand in as the earliest membership start.
    expect(isCyberMondayOnly(CYBER_GIFT, [NULL_START, MEMBERSHIP, CYBER_GIFT])).toBe(true)
    // Last in the list too: a NULL must not reset the scan after a real start.
    expect(isCyberMondayOnly(CYBER_GIFT, [MEMBERSHIP, NULL_START, CYBER_GIFT])).toBe(true)
    expect(isCyberMondayOnly(CYBER_GIFT, [NULL_START, CYBER_GIFT])).toBe(false)
    expect(isCyberMondayOnly({ ...CYBER_GIFT, starts_at: null }, [MEMBERSHIP])).toBe(false)
  })
})
