import { describe, it, expect } from 'vitest'
import { CORP_PROMOS, CORP_PROMO_COPY_DEFAULT, resolveCorpPromo, liveCorpPromos, corpPromoCopyFromBlocks, fillCorpPromoTokens } from './corp-promos'

describe('corp promo registry', () => {
  it('hatch-3-free: 3 credits for 7 days at Hatch Street, live', () => {
    expect(resolveCorpPromo('hatch-3-free')).toMatchObject({ studio: 'hatch', publicPath: 'hatch-street', credits: 3, expiresInDays: 7, live: true })
    expect(Object.isFrozen(CORP_PROMOS['hatch-3-free'])).toBe(true)
  })

  it('an unknown or non-string key is null; an inherited name is not a promo', () => {
    expect(resolveCorpPromo('nope')).toBeNull()
    expect(resolveCorpPromo(undefined)).toBeNull()
    expect(resolveCorpPromo('toString')).toBeNull()
  })

  it('lists only live promos', () => {
    expect(liveCorpPromos().map((p) => p.key)).toEqual(['hatch-3-free'])
  })
})

describe('corpPromoCopyFromBlocks', () => {
  it('no block: every default', () => {
    expect(corpPromoCopyFromBlocks([], 'hatch-3-free')).toEqual({ ...CORP_PROMO_COPY_DEFAULT, ticks: [...CORP_PROMO_COPY_DEFAULT.ticks] })
  })

  it('blank fields fall back; filled ones win; blank ticks skipped', () => {
    const copy = corpPromoCopyFromBlocks([{ type: 'corp_promo', heading: 'Hello', cta_label: '  ', ticks: ['One', ''] }], 'hatch-3-free')
    expect(copy.heading).toBe('Hello')
    expect(copy.cta_label).toBe(CORP_PROMO_COPY_DEFAULT.cta_label)
    expect(copy.ticks).toEqual(['One'])
  })

  it("the block naming this promo wins over a general one; another promo's block is never used", () => {
    const blocks = [
      { type: 'corp_promo', promo_key: 'other', heading: 'Other' },
      { type: 'corp_promo', heading: 'General' },
      { type: 'corp_promo', promo_key: 'hatch-3-free', heading: 'Mine' },
    ]
    expect(corpPromoCopyFromBlocks(blocks, 'hatch-3-free').heading).toBe('Mine')
    expect(corpPromoCopyFromBlocks(blocks.slice(0, 2), 'hatch-3-free').heading).toBe('General')
    expect(corpPromoCopyFromBlocks(blocks.slice(0, 1), 'hatch-3-free').heading).toBe(CORP_PROMO_COPY_DEFAULT.heading)
  })
})

describe('fillCorpPromoTokens', () => {
  it('fills known tokens and leaves unknown ones', () => {
    expect(fillCorpPromoTokens('{credits} by {expires_on} {x}', { credits: 3, expires_on: 'Tue 4 Nov' })).toBe('3 by Tue 4 Nov {x}')
  })
})
