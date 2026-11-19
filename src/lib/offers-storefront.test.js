import { describe, it, expect } from 'vitest'
import { parseBonus, offerValueLine, offerTermLine, splitMonthStrip, heroFor, storefrontTitle, storefrontShare, offerShare, offersShareMetadata, CATEGORY_ORDER, storefrontOffers, storefrontCountdown, isCyberMondayOnly, offerFinePrint } from './offers-storefront'
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

describe('BLACKFRIDAY.8 card numeral and flag for suffixed slugs', () => {
  it('reads the term off a -bf-2026 slug', async () => {
    const { termForSlug } = await import('./offers-storefront')
    expect(termForSlug('1-year-membership-bf-2026')).toEqual({ num: '12', label: 'MONTHS' })
    expect(termForSlug('1-year-membership')).toEqual({ num: '12', label: 'MONTHS' })
    expect(termForSlug('1-month-membership-bf-2026')).toEqual({ num: '1', label: 'MONTH' })
    expect(termForSlug('3-month-membership-bf-2026')).toEqual({ num: '3', label: 'MONTHS' })
    expect(termForSlug('6-month-membership-bf-2026')).toEqual({ num: '6', label: 'MONTHS' })
    expect(termForSlug('30-class-pack-bf-2026')).toEqual({ num: '30', label: 'CLASSES' })
    expect(termForSlug('gift-a-reset')).toBeNull()
  })
  it('flags the biggest bonus on suffixed and plain slugs', async () => {
    const { flagForSlug } = await import('./offers-storefront')
    expect(flagForSlug('1-year-membership-bf-2026')).toBe('Biggest bonus')
    expect(flagForSlug('30-class-pack-bf-2026')).toBe('Biggest pack bonus')
    expect(flagForSlug('30-class-pack')).toBe('Biggest pack bonus')
    expect(flagForSlug('20-class-pack-bf-2026')).toBeNull()
  })
})

// BLACKFRIDAY.9 — fine print shows for any studio's offer that has some.
describe('offerFinePrint', () => {
  it('returns non-empty fine print whatever the studio', () => {
    expect(offerFinePrint({ fine_print: 'Valid to 31 Jan', location_id: 'loc-stillorgan' })).toBe('Valid to 31 Jan')
    expect(offerFinePrint({ fine_print: 'Hatch only' })).toBe('Hatch only')
  })
  it('null for blank, missing or non-string fine print', () => {
    expect(offerFinePrint({ fine_print: '   ' })).toBeNull()
    expect(offerFinePrint({ fine_print: null })).toBeNull()
    expect(offerFinePrint({})).toBeNull()
    expect(offerFinePrint(null)).toBeNull()
  })
})

describe('link previews and tab titles (OFFERSPOLISH.1)', () => {
  const copy = { marquee: 'M · ', line1: 'L1', line2: 'L2', blurb: 'Studio blurb.' }

  it('a storefront shares its tab title and the studio blurb', () => {
    expect(storefrontShare(new Set(['membership']), copy, 'UN1T Hatch Street'))
      .toEqual({ title: 'Black Friday — UN1T Hatch Street', description: 'Studio blurb.' })
    expect(storefrontShare(['gift_card'], copy, 'UN1T Stillorgan').title).toBe('Gift Cards — UN1T Stillorgan')
    expect(storefrontShare(['gift_card'], copy).description).toMatch(/gift card/i)
  })

  it('a product page is titled by the offer first, so two tabs differ', () => {
    const a = offerShare({ name: '3 Month Membership', description: ' 3 months, plus 3 weeks. ' }, 'UN1T Hatch Street')
    const b = offerShare({ name: '12 Month Membership', description: '' }, 'UN1T Hatch Street')
    expect(a).toEqual({ title: '3 Month Membership — UN1T Hatch Street', description: '3 months, plus 3 weeks.' })
    expect(b).toEqual({ title: '12 Month Membership — UN1T Hatch Street', description: null })
    expect(offerShare({}, 'UN1T Stillorgan').title).toBe('Black Friday — UN1T Stillorgan')
  })

  it('states its own Open Graph block, since Next replaces the root one whole', () => {
    const m = offersShareMetadata({ title: 'T', description: 'D', siteName: 'UN1T Stillorgan', image: 'https://cdn.example/logo.png' })
    expect(m.title).toBe('T')
    expect(m.description).toBe('D')
    expect(m.robots).toEqual({ index: false, follow: false })
    expect(m.openGraph).toEqual({ title: 'T', description: 'D', siteName: 'UN1T Stillorgan', type: 'website', images: [{ url: 'https://cdn.example/logo.png' }] })
    expect(m.twitter).toEqual({ card: 'summary', title: 'T', description: 'D', images: ['https://cdn.example/logo.png'] })
  })

  it('leaves out an empty description and an image that is not absolute https', () => {
    const m = offersShareMetadata({ title: 'T', description: '  ', siteName: 'UN1T', image: '/logo.png' })
    expect(m).not.toHaveProperty('description')
    expect(m.openGraph).toEqual({ title: 'T', siteName: 'UN1T', type: 'website' })
    expect(m.twitter).toEqual({ card: 'summary', title: 'T' })
    expect(offersShareMetadata({ title: 'T', siteName: 'UN1T', image: 'http://x/logo.png' }).openGraph.images).toBeUndefined()
  })
})

describe('bonus-first cards (OFFERSDESIGN.1)', () => {
  const m = (slug, bonus, cents) => ({ slug, category: 'membership', bonus_headline: bonus, price_cents: cents })
  const p = (slug, bonus, cents) => ({ slug, category: 'class_pack', bonus_headline: bonus, price_cents: cents })

  it('reads the free extra off the bonus headline', () => {
    expect(parseBonus('+3 MONTHS FREE')).toEqual({ n: 3, unit: 'month' })
    expect(parseBonus('+1 week free')).toEqual({ n: 1, unit: 'week' })
    expect(parseBonus('+10 CLASSES FREE')).toEqual({ n: 10, unit: 'class' })
    expect(parseBonus('Bonus on the house')).toBeNull()
    expect(parseBonus(null)).toBeNull()
  })

  it('a membership card shows no "About ... a month" line', () => {
    expect(offerValueLine(m('1-year-membership-bf-2026', '+3 MONTHS FREE', 216900))).toBeNull()
    expect(offerValueLine(m('6-month-membership-bf-2026', '+6 WEEKS FREE', 114400))).toBeNull()
    expect(offerValueLine(m('3-month-membership-bf-2026', '+3 WEEKS FREE', 62700))).toBeNull()
    expect(offerValueLine(m('1-month-membership-bf-2026', '+2 WEEKS FREE', 9900))).toBeNull()
  })

  it('a class pack states its price over every class, bonus included', () => {
    expect(offerValueLine(p('30-class-pack-bf-2026', '+10 CLASSES FREE', 51000))).toBe('About €12.75 a class')
    expect(offerValueLine(p('20-class-pack-bf-2026', '+5 CLASSES FREE', 38000))).toBe('About €15.20 a class')
  })

  it('says nothing it cannot work out', () => {
    expect(offerValueLine({ slug: 'gift-card-100', category: 'gift_card', price_cents: 10000 })).toBeNull()
    expect(offerValueLine(m('1-year-membership', 'Biggest deal', 216900))).toBeNull()
    expect(offerValueLine(m('mystery-offer', '+3 MONTHS FREE', 216900))).toBeNull()
    expect(offerValueLine(m('1-year-membership', '+3 MONTHS FREE', 0))).toBeNull()
    expect(offerValueLine(p('30-class-pack', '+2 WEEKS FREE', 51000))).toBeNull()
  })

  it('names what the bonus is on', () => {
    expect(offerTermLine({ slug: '1-year-membership-bf-2026' })).toBe('On 12 months')
    expect(offerTermLine({ slug: '1-month-membership-bf-2026' })).toBe('On 1 month')
    expect(offerTermLine({ slug: '30-class-pack-bf-2026' })).toBe('On 30 classes')
    expect(offerTermLine({ slug: 'gift-card-100' })).toBeNull()
  })

  it('moves a one-month membership out of the card grid into its own strip', () => {
    const rows = [
      m('1-year-membership-bf-2026', '+3 MONTHS FREE', 1),
      m('1-month-membership-bf-2026', '+2 WEEKS FREE', 1),
      m('3-month-membership-bf-2026', '+3 WEEKS FREE', 1),
    ]
    const { grid, strip } = splitMonthStrip(rows)
    expect(grid.map((o) => o.slug)).toEqual(['1-year-membership-bf-2026', '3-month-membership-bf-2026'])
    expect(strip.map((o) => o.slug)).toEqual(['1-month-membership-bf-2026'])
    expect(splitMonthStrip([p('20-class-pack', '+5', 1)]).strip).toEqual([])
  })
})
