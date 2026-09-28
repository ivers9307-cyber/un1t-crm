// CONTRACTORSPEND.1 — the contractor-spend read prices every live assignment at
// this studio in the Dublin month, by HOLDER (never by membership here), with
// pay from profile_compensation, pages the block read, fails loudly, and
// returns studio totals only.
// SHIFTTYPE.1 (kept) — the read carries each block's template kind, so the
// panel and the publish gate price the same shifts.
import { describe, it, expect } from 'vitest'
import { computeMonthlyContractorSpend, CONTRACTOR_SPEND_KEYS, SALARY_DERIVED_SPEND_KEYS, contractorSpendOnly } from './roster-summary-server'
import { fakeSpendDb, spendBlock } from './roster-summary.test-helpers'

// hourly_rate 999 on profiles = the DEPRECATED copy; it must never be priced.
const DAN = { id: 'dan', full_name: 'Dan', active: true, employment_type: 'contractor', hourly_rate: 999 }
const GUS = { id: 'gus', full_name: 'Gus', active: true, employment_type: 'contractor', hourly_rate: 999 }
const COMP = [{ profile_id: 'dan', hourly_rate: 35 }, { profile_id: 'gus', hourly_rate: 40 }]
const MAY = { locationId: 'loc1', referenceDate: '2026-05-15' }

describe('computeMonthlyContractorSpend', () => {
  it('SHIFTTYPE.1: selects the template kind and leaves admin shifts out of the spend', async () => {
    const db = fakeSpendDb({
      blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00'), spendBlock('a', '2026-05-05', '09:00', '13:00', ['dan'], { kind: 'admin' })],
      profiles: [DAN], comp: COMP,
    })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(db.selectOf('shift_blocks')).toMatch(/shift_templates\(start_time, end_time, kind\)/)
    expect(r.contractorCostEur).toBe(70)
    expect(r.remainingEur).toBe(30)
  })

  it('prices a contractor from the sibling studio who worked here, and never reads memberships', async () => {
    const db = fakeSpendDb({ blocks: [spendBlock('g', '2026-05-06', '09:00', '11:00', ['gus'])], profiles: [GUS], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(r.contractorCostEur).toBe(80) // 2h × 40
    expect(db.tables()).not.toContain('profile_locations')
  })

  it('prices a contractor deactivated mid-month', async () => {
    const db = fakeSpendDb({ blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00')], profiles: [{ ...DAN, active: false }], comp: COMP })
    expect((await computeMonthlyContractorSpend({ db, ...MAY })).contractorCostEur).toBe(70)
  })

  it('takes rates from profile_compensation, never from profiles', async () => {
    const db = fakeSpendDb({ blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00')], profiles: [DAN], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(r.contractorCostEur).toBe(70) // not 2h × 999
    expect(db.selectOf('profiles')).toBe('id, employment_type')
  })

  it('reads the month from the reference string and scopes the block read to this studio', async () => {
    const db = fakeSpendDb({ blocks: [], profiles: [DAN], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, locationId: 'loc1', referenceDate: '2026-10-01' })
    expect(db.blockQueries()[0]).toMatchObject({
      eq: { location_id: 'loc1' }, gte: { block_date: '2026-10-01' }, lte: { block_date: '2026-10-31' },
    })
    expect(r).toMatchObject({ monthStartIso: '2026-10-01', monthEndIso: '2026-10-31' })
  })

  it('counts published shifts as spend and reports the rest beside it', async () => {
    const db = fakeSpendDb({
      blocks: [
        spendBlock('p', '2026-05-04', '09:00', '11:00'), // 70 published
        spendBlock('u', '2026-05-05', '09:00', '11:00', ['dan'], { roster: null }), // 70, no roster
      ],
      profiles: [DAN], comp: COMP,
    })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(db.selectOf('shift_blocks')).toMatch(/rosters:roster_id \( status \)/)
    expect(r).toMatchObject({ contractorCostEur: 70, unpublishedContractorCostEur: 70, projectedContractorCostEur: 140, overBudget: false, projectedOverBudget: true })
  })

  it('pages the block read past 1,000 rows, ordered by id, and prices the second page', async () => {
    const blocks = Array.from({ length: 1001 }, (_, i) => spendBlock(`b${String(i).padStart(4, '0')}`, '2026-05-04', '09:00', '10:00'))
    const db = fakeSpendDb({ location: { id: 'loc1', monthly_contractor_budget_eur: null }, blocks, profiles: [DAN], comp: COMP })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(db.blockQueries().map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
    for (const q of db.blockQueries()) expect(q.order).toEqual([['id', true]])
    expect(r.contractorCostEur).toBe(35035) // 1,001 × 1h × 35
  })

  for (const table of ['shift_blocks', 'profiles', 'profile_compensation']) {
    it(`a failed ${table} read throws: never a EUR 0 spend`, async () => {
      const db = fakeSpendDb({ blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00')], profiles: [DAN], comp: COMP, fail: { [table]: true } })
      await expect(computeMonthlyContractorSpend({ db, ...MAY })).rejects.toThrow(/unreadable/)
    })
  }

  it('an unreadable location is LOCATION_NOT_FOUND (the route answers 404)', async () => {
    const db = fakeSpendDb({ fail: { locations: true } })
    await expect(computeMonthlyContractorSpend({ db, ...MAY })).rejects.toMatchObject({ code: 'LOCATION_NOT_FOUND' })
  })

  it('returns studio totals only: no per-person figure, name, rate or id', async () => {
    const db = fakeSpendDb({
      blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00', ['dan', 'gus'])],
      profiles: [DAN, GUS], comp: COMP,
    })
    const r = await computeMonthlyContractorSpend({ db, ...MAY })
    expect(Object.keys(r).sort()).toEqual([
      'contractorCostEur', 'fteImplicitCostEur', 'monthEndIso', 'monthStartIso', 'monthlyBudgetEur',
      'overBudget', 'projectedContractorCostEur', 'projectedOverBudget', 'remainingEur',
      'unpublishedContractorCostEur', 'utilisationPct',
    ])
    expect(JSON.stringify(r)).not.toMatch(/\bdan\b|\bgus\b|rate|salary|profile/i)
  })
})

// FTECOSTVIS.1 (Richard, 28 Sep 2026: "keep the cost hidden") — the FTE labour
// total is rostered hours × salary / 52 / contracted hours: with one employee
// on the month's shifts it IS their pay. Head coaches get the contractor
// figures only, through an allowlist, so an unclassified key never reaches them.
// annual_salary 999999 on profiles = the deprecated copy; never read.
const EVE = { id: 'eve', full_name: 'Eve', active: true, employment_type: 'fte', annual_salary: 999999 }
const EVE_COMP = { profile_id: 'eve', annual_salary: 31200, contracted_hours_per_week: 30 } // 31,200 / 52 / 30 = EUR 20 an hour

function danAndEve() {
  return fakeSpendDb({
    blocks: [spendBlock('c', '2026-05-04', '09:00', '11:00', ['dan', 'eve'])],
    profiles: [DAN, EVE], comp: [...COMP, EVE_COMP],
  })
}

describe('FTECOSTVIS.1 — what a head coach may see of the spend', () => {
  it('every key the spend returns is classified exactly once: contractor or salary-derived', async () => {
    const r = await computeMonthlyContractorSpend({ db: danAndEve(), ...MAY })
    expect([...CONTRACTOR_SPEND_KEYS, ...SALARY_DERIVED_SPEND_KEYS].sort()).toEqual(Object.keys(r).sort())
    expect(CONTRACTOR_SPEND_KEYS.filter((k) => SALARY_DERIVED_SPEND_KEYS.includes(k))).toEqual([])
  })

  it('the FTE labour total is the one salary-derived figure', () => {
    expect([...SALARY_DERIVED_SPEND_KEYS]).toEqual(['fteImplicitCostEur'])
  })

  it('contractorSpendOnly keeps every contractor figure and drops the FTE labour total', async () => {
    const r = await computeMonthlyContractorSpend({ db: danAndEve(), ...MAY })
    expect(r.fteImplicitCostEur).toBe(40) // 2h × EUR 20: the figure is really there to drop
    expect(r.contractorCostEur).toBe(70) // 2h × EUR 35
    const shown = contractorSpendOnly(r)
    expect(shown).not.toHaveProperty('fteImplicitCostEur')
    for (const k of CONTRACTOR_SPEND_KEYS) expect(shown[k]).toEqual(r[k])
    expect(JSON.stringify(shown)).not.toMatch(/fte|salary/i)
  })

  it('contractorSpendOnly fails closed: a key nobody classified never passes', () => {
    expect(contractorSpendOnly({ contractorCostEur: 1, fteProjectedCostEur: 2, somethingNew: 3 })).toEqual({ contractorCostEur: 1 })
  })

  it('contractorSpendOnly of nothing is an empty object', () => {
    expect(contractorSpendOnly(null)).toEqual({})
    expect(contractorSpendOnly(undefined)).toEqual({})
  })
})
