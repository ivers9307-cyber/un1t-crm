// CONTRACTORSPEND.1 — the contractor-spend month on a host WEST of UTC. The
// calendar always sends the 1st; summarizeMonth used to parse it as UTC
// midnight and read local getters, which here is 30 Sep 17:00: the read fetched
// October, the sum kept September's blocks (none), and the panel said EUR 0.
process.env.TZ = 'America/Los_Angeles'

import { describe, it, expect } from 'vitest'

const { summarizeMonth } = await import('./roster-summary.js')
const { computeMonthlyContractorSpend } = await import('./roster-summary-server.js')
const H = await import('./roster-summary.test-helpers.js')

describe('contractor spend month — America/Los_Angeles (PDT, UTC-7)', () => {
  it('the host really is on Pacific time', () => {
    expect(new Date('2026-10-01T12:00:00Z').getHours()).toBe(5)
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
