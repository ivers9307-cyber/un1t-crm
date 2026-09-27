// CONTRACTORSPEND.1 — the same October 2026 month on a Dublin host. October is
// the clocks-back month (Sunday 25 Oct: 02:00 IST becomes 01:00 GMT); the month
// is calendar strings, so neither end moves and the 25th is an ordinary day.
process.env.TZ = 'Europe/Dublin'

import { describe, it, expect } from 'vitest'

const { summarizeMonth } = await import('./roster-summary.js')
const { computeMonthlyContractorSpend } = await import('./roster-summary-server.js')
const H = await import('./roster-summary.test-helpers.js')

describe('contractor spend month — Europe/Dublin (IST, UTC+1 until 25 Oct)', () => {
  it('the host really is on Dublin time', () => {
    expect(new Date('2026-10-01T12:00:00Z').getHours()).toBe(13)
    expect(new Date('2026-10-26T12:00:00Z').getHours()).toBe(12)
  })

  for (const ref of H.OCT_REFERENCE_DATES) {
    it(`summarizeMonth(${ref}) is October 2026: the 1st and 31st in, 30 Sep and 1 Nov out`, () => {
      const r = summarizeMonth({ blocks: H.OCT_BLOCKS, pay: H.OCT_PAY, referenceDate: ref, monthlyBudgetEur: 300 })
      expect(r).toMatchObject({ ...H.OCT_EXPECTED, remainingEur: 55, overBudget: false })
    })

    it(`the server read for ${ref} asks for 1-31 October and prices it`, async () => {
      const db = H.fakeSpendDb({ location: { id: 'loc1', monthly_contractor_budget_eur: 300 }, blocks: H.OCT_BLOCKS, profiles: H.OCT_PROFILES, comp: H.OCT_COMP })
      const r = await computeMonthlyContractorSpend({ db, locationId: 'loc1', referenceDate: ref })
      expect(db.blockQueries()[0]).toMatchObject({ gte: { block_date: '2026-10-01' }, lte: { block_date: '2026-10-31' } })
      expect(r).toMatchObject({ ...H.OCT_EXPECTED, remainingEur: 55 })
    })
  }
})
