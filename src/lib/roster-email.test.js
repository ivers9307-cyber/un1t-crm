// OVERBUDGET-COPY.1 — the over-budget approval email.
//
// Two findings, both about an owner reading a sentence that is not true of
// the draft in front of them:
//
//   1. "Staff cannot see their shifts until then" is false when the period is
//      already published. Re-publishing a live week holds back the CHANGES,
//      not the roster, and every shift on it stays exactly as visible as it
//      was. The wording now depends on what is already live.
//   2. The budget is MONTHLY and #1704 projects per month, so a period
//      crossing a month boundary has one overrun PER MONTH. A single summed
//      figure never said which month to look at.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark', () => ({ sendEmail: vi.fn(() => Promise.resolve()) }))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.example.test' }))
vi.mock('./log', () => ({ logWarn: vi.fn() }))

const { sendEmail } = await import('./postmark')
const { sendOverBudgetApprovalEmail, approvalVisibilityLine, monthLabel } = await import('./roster-email')

function mockDb() {
  return {
    from(table) {
      if (table === 'profile_locations') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({
                data: [{ profile_id: 'p1', profiles: { id: 'p1', full_name: 'Ada', email: 'ada@example.test', active: true } }],
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { name: 'UN1T Stillorgan' }, error: null }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const BASE = {
  rosterId: 'r-1',
  locationId: 'loc-1',
  publisherName: 'Colm',
  periodStart: '2026-08-31',
  periodEnd: '2026-09-30',
  overrunEur: 400,
  budgetEur: 5000,
}

async function sendAndRead(extra = {}) {
  await sendOverBudgetApprovalEmail(mockDb(), { ...BASE, ...extra })
  return sendEmail.mock.calls.at(-1)[0].htmlBody
}

beforeEach(() => { sendEmail.mockClear() })

describe('approvalVisibilityLine', () => {
  it('says staff cannot see their shifts only when nothing on the period is published', () => {
    expect(approvalVisibilityLine({})).toMatch(/Staff cannot see their shifts until then/)
  })

  it('does NOT claim staff are in the dark when the whole period is already live', () => {
    const line = approvalVisibilityLine({ alreadyPublished: true, fullyPublished: true })
    expect(line).not.toMatch(/cannot see/i)
    expect(line).toMatch(/already published/)
    expect(line).toMatch(/change in this draft/)
  })

  it('says which half is live when only part of the period is published', () => {
    const line = approvalVisibilityLine({ alreadyPublished: true, fullyPublished: false })
    expect(line).toMatch(/Part of this period is already published/)
    expect(line).not.toMatch(/cannot see/i)
  })
})

describe('monthLabel', () => {
  it('reads the month in UTC, so a 1st never falls back a month', () => {
    expect(monthLabel('2026-09-01')).toBe('September 2026')
    expect(monthLabel('2026-01-01')).toBe('January 2026')
  })
})

describe('sendOverBudgetApprovalEmail', () => {
  it('carries the un-published wording by default', async () => {
    const html = await sendAndRead()
    expect(html).toMatch(/Staff cannot see their shifts until then/)
  })

  it('carries the already-live wording when the period is published', async () => {
    const html = await sendAndRead({ alreadyPublished: true, fullyPublished: true })
    expect(html).not.toMatch(/cannot see/i)
  })

  it('splits the overrun per month when the period crosses a boundary', async () => {
    const html = await sendAndRead({
      months: [
        { monthStart: '2026-08-01', monthProjectedTotalEur: 5100, monthlyBudgetEur: 5000, overrunEur: 100 },
        { monthStart: '2026-09-01', monthProjectedTotalEur: 5300, monthlyBudgetEur: 5000, overrunEur: 300 },
      ],
    })
    expect(html).toMatch(/August 2026/)
    expect(html).toMatch(/September 2026/)
    expect(html).toMatch(/€100 over/)
    expect(html).toMatch(/€300 over/)
  })

  it('names a month that is within budget rather than dropping it', async () => {
    const html = await sendAndRead({
      months: [
        { monthStart: '2026-08-01', monthProjectedTotalEur: 5400, monthlyBudgetEur: 5000, overrunEur: 400 },
        { monthStart: '2026-09-01', monthProjectedTotalEur: 4200, monthlyBudgetEur: 5000, overrunEur: 0 },
      ],
    })
    expect(html).toMatch(/September 2026: €4,200 projected against the €5,000 monthly budget/)
    expect(html).toMatch(/within budget/)
  })

  it('renders no breakdown for a single-month period', async () => {
    const html = await sendAndRead({
      months: [{ monthStart: '2026-09-01', monthProjectedTotalEur: 5400, monthlyBudgetEur: 5000, overrunEur: 400 }],
    })
    expect(html).not.toMatch(/runs across/)
  })
})
