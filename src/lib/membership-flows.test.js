import { describe, it, expect } from 'vitest'
import {
  weekStartStr,
  weekKeys,
  fetchMembershipFlows,
  SALES_DATA_START,
  CANCEL_TRACKING_START,
} from './membership-flows.js'

describe('weekStartStr', () => {
  it('returns the Monday of the containing week', () => {
    expect(weekStartStr('2026-07-29')).toBe('2026-07-27') // Wednesday
    expect(weekStartStr('2026-07-27')).toBe('2026-07-27') // Monday itself
    expect(weekStartStr('2026-08-02')).toBe('2026-07-27') // Sunday belongs to prior Monday
  })

  it('crosses month and year boundaries', () => {
    expect(weekStartStr('2026-08-01')).toBe('2026-07-27')
    expect(weekStartStr('2026-01-01')).toBe('2025-12-29')
  })
})

describe('weekKeys', () => {
  it('returns N Mondays oldest→newest ending with the current week', () => {
    const keys = weekKeys(3, '2026-07-29')
    expect(keys).toEqual(['2026-07-13', '2026-07-20', '2026-07-27'])
  })
})

// Fake supabase builder: routes .from(table) to canned rows and
// records filters for assertions.
function fakeDb(tables) {
  const calls = {}
  return {
    _calls: calls,
    from(table) {
      const rec = (calls[table] ||= {})
      const b = {
        select: () => b,
        eq: (c, v) => { (rec.eq ||= []).push([c, v]); return b },
        like: (c, v) => { rec.like = [c, v]; return b },
        gte: (c, v) => { rec.gte = [c, v]; return b },
        order: () => b,
        limit: () => Promise.resolve(tables[table] || { data: [], error: null }),
      }
      return b
    },
  }
}

// 2026-07-29T12:00:00Z as a fixed "now" (Date.now() is banned-ish in
// prod paths but fine to pin in tests via the nowMs parameter).
const NOW = Date.UTC(2026, 6, 29, 12)

describe('fetchMembershipFlows', () => {
  it('buckets first-sale-per-contact and cancels into Monday weeks', async () => {
    const db = fakeDb({
      glofox_invoices: {
        data: [
          { contact_id: 'a', invoice_date: '2026-07-14T10:00:00Z' }, // week 07-13
          { contact_id: 'a', invoice_date: '2026-07-21T10:00:00Z' }, // retry — deduped
          { contact_id: 'b', invoice_date: '2026-07-28T10:00:00Z' }, // week 07-27
        ],
        error: null,
      },
      membership_transitions: {
        data: [{ occurred_at: '2026-07-29T08:00:00Z' }],
        error: null,
      },
    })
    const { weeks } = await fetchMembershipFlows(db, 'loc-1', 3, NOW)
    expect(weeks.map((w) => w.week)).toEqual(['2026-07-13', '2026-07-20', '2026-07-27'])
    expect(weeks[0].sales).toBe(1)
    expect(weeks[1].sales).toBe(0) // the retry did not double-count
    expect(weeks[2].sales).toBe(1)
    expect(weeks[2].cancellations).toBe(1)
  })

  it('dedupes against a first sale before the display window', async () => {
    const db = fakeDb({
      glofox_invoices: {
        data: [
          { contact_id: 'a', invoice_date: '2026-05-14T10:00:00Z' }, // real sale, off-window
          { contact_id: 'a', invoice_date: '2026-07-28T10:00:00Z' }, // later invoice — not a new sale
        ],
        error: null,
      },
      membership_transitions: { data: [], error: null },
    })
    const { weeks } = await fetchMembershipFlows(db, 'loc-1', 3, NOW)
    expect(weeks.every((w) => w.sales === 0)).toBe(true)
  })

  it('nulls cancellations for weeks before tracking started', async () => {
    const db = fakeDb({
      glofox_invoices: { data: [], error: null },
      membership_transitions: { data: [], error: null },
    })
    const { weeks, cancelTrackingStart } = await fetchMembershipFlows(db, 'loc-1', 4, NOW)
    expect(cancelTrackingStart).toBe(CANCEL_TRACKING_START)
    // tracking started 2026-07-29 → only the 07-27 week has a number
    expect(weeks.map((w) => w.cancellations)).toEqual([null, null, null, 0])
    // sales data exists from mid-May, so all four weeks are numeric
    expect(weeks.every((w) => w.sales === 0)).toBe(true)
  })

  it('nulls sales for weeks before the invoice webhook log existed', async () => {
    const db = fakeDb({
      glofox_invoices: { data: [], error: null },
      membership_transitions: { data: [], error: null },
    })
    // 20-week window reaches back past 2026-05-12
    const { weeks } = await fetchMembershipFlows(db, 'loc-1', 20, NOW)
    const firstReliable = weekStartStr(SALES_DATA_START)
    for (const w of weeks) {
      expect(w.sales).toBe(w.week >= firstReliable ? 0 : null)
    }
  })

  it('scopes both queries to the location and filters sales to paid subscription starts', async () => {
    const db = fakeDb({
      glofox_invoices: { data: [], error: null },
      membership_transitions: { data: [], error: null },
    })
    await fetchMembershipFlows(db, 'loc-9', 3, NOW)
    expect(db._calls.glofox_invoices.eq).toContainEqual(['location_id', 'loc-9'])
    expect(db._calls.glofox_invoices.eq).toContainEqual(['status', 'PAID'])
    expect(db._calls.glofox_invoices.like).toEqual(['line_item_subtypes', '%SUBSCRIPTION_PAYMENT%'])
    expect(db._calls.membership_transitions.eq).toContainEqual(['location_id', 'loc-9'])
    expect(db._calls.membership_transitions.eq).toContainEqual(['kind', 'recurring_cancel'])
  })

  it('throws on a db error', async () => {
    const db = fakeDb({
      glofox_invoices: { data: null, error: { message: 'kaboom' } },
      membership_transitions: { data: [], error: null },
    })
    await expect(fetchMembershipFlows(db, 'loc-1', 3, NOW)).rejects.toThrow(/kaboom/)
  })
})
