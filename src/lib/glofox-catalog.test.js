// GLOFOX-CATALOG — tests for the catalog parser + resolver, built from
// the REAL /2.0/memberships response shape (Stillorgan, 8 plans).
import { describe, it, expect } from 'vitest'
import { stripPlanPrefix, parseMembershipCatalog, matchCatalogToPlan } from './glofox-catalog'

const LOC = 'a0000000-0000-0000-0000-000000000001'

// Trimmed but faithful to the live payload.
const REAL_BODY = {
  object: 'list', total_count: 3,
  data: [
    {
      _id: '659442d20e66eb19f0074532',
      name: '2) The Monthly Membership (€99 FIRST MONTH)',
      description: '€99 first months membership\n€209 per month thereafter - requires a 30-day notice to cancel with a 3 month commitment.',
      active: true, type: 'membership',
      plans: [{ code: 1704215234363, price: 99, type: 'time', name: 'Month to Month Membership' }],
    },
    {
      _id: '659443a6a0b7d1b6a40687dc',
      name: '3) The 3 Month Membership - €100 Discount',
      description: '€199 per month billed every 3 Months\n\nRequires 30-day notice to cancel',
      active: true, type: 'membership',
      plans: [{ code: 1704215281195, price: 497, type: 'time', name: '3 Month Membership' }],
    },
    {
      _id: '620bdab4df0f8054814cd7be',
      name: '1) The UN1T Trial',
      description: '3  Classes - 7 Day Expiry',
      active: true, type: 'membership',
      plans: [{ code: 1644944026897, price: 0, type: 'num_classes', name: 'The UN1T Trial' }],
    },
  ],
}

describe('stripPlanPrefix', () => {
  it('drops the "N) " sort-order prefix', () => {
    expect(stripPlanPrefix('3) The 3 Month Membership - €100 Discount')).toBe('The 3 Month Membership - €100 Discount')
    expect(stripPlanPrefix('Class Packs')).toBe('Class Packs')
    expect(stripPlanPrefix(null)).toBeNull()
  })
})

describe('parseMembershipCatalog', () => {
  const rows = parseMembershipCatalog(REAL_BODY, LOC)

  it('parses one row per membership with the description captured', () => {
    expect(rows).toHaveLength(3)
    const monthly = rows.find(r => r.glofox_membership_id === '659442d20e66eb19f0074532')
    expect(monthly.description).toContain('thereafter')
    expect(monthly.description).toContain('3 month commitment')
    expect(monthly.name_clean).toBe('The Monthly Membership (€99 FIRST MONTH)')
    expect(monthly.plan_names).toEqual(['Month to Month Membership'])
    expect(monthly.price_cents).toBe(9900)
    expect(monthly.location_id).toBe(LOC)
    expect(monthly.active).toBe(true)
  })

  it('handles a bare array body too', () => {
    expect(parseMembershipCatalog(REAL_BODY.data, LOC)).toHaveLength(3)
  })

  it('skips entries without an id and tolerates junk', () => {
    expect(parseMembershipCatalog({ data: [{ name: 'no id' }, null, 5] }, LOC)).toEqual([])
    expect(parseMembershipCatalog(null, LOC)).toEqual([])
  })

  it('nulls description when absent/blank', () => {
    const r = parseMembershipCatalog({ data: [{ _id: 'x', name: 'X', description: '  ' }] }, LOC)
    expect(r[0].description).toBeNull()
  })
})

describe('matchCatalogToPlan', () => {
  const catalog = parseMembershipCatalog(REAL_BODY, LOC)

  it('matches by full catalog name (planFull)', () => {
    const row = matchCatalogToPlan(catalog, { planFull: 'The 3 Month Membership - €100 Discount' })
    expect(row?.glofox_membership_id).toBe('659443a6a0b7d1b6a40687dc')
    expect(row.description).toContain('€199 per month')
  })

  it('matches by plans[].name (the clean plan)', () => {
    const row = matchCatalogToPlan(catalog, { plan: '3 Month Membership' })
    expect(row?.glofox_membership_id).toBe('659443a6a0b7d1b6a40687dc')
  })

  it('is case-insensitive', () => {
    expect(matchCatalogToPlan(catalog, { plan: 'the un1t trial' })?.name_clean).toBe('The UN1T Trial')
  })

  it('returns null for an archived/unknown plan (e.g. old Black Friday)', () => {
    expect(matchCatalogToPlan(catalog, { plan: 'Black Friday Unlimited Monthly Membership (Plan 1)' })).toBeNull()
  })

  it('returns null on empty inputs', () => {
    expect(matchCatalogToPlan([], { plan: 'x' })).toBeNull()
    expect(matchCatalogToPlan(catalog, {})).toBeNull()
  })
})
