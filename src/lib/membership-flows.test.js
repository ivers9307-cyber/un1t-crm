import { describe, it, expect } from 'vitest'
import {
  monthKeys,
  fetchMembershipFlows,
  SALES_DATA_START,
  CANCEL_TRACKING_START,
} from './membership-flows.js'

describe('monthKeys', () => {
  it('returns N months oldest→newest ending with the current month', () => {
    expect(monthKeys(3, '2026-07-29')).toEqual(['2026-05', '2026-06', '2026-07'])
  })

  it('crosses year boundaries', () => {
    expect(monthKeys(4, '2026-02-10')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
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

// 2026-07-29T12:00:00Z as a fixed "now", injected via the nowMs param.
const NOW = Date.UTC(2026, 6, 29, 12)

describe('fetchMembershipFlows', () => {
  it('buckets first-sale-per-contact and cancels into calendar months', async () => {
    const db = fakeDb({
      glofox_invoices: {
        data: [
          { contact_id: 'a', invoice_date: '2026-05-14T10:00:00Z' }, // May
          { contact_id: 'a', invoice_date: '2026-06-02T10:00:00Z' }, // retry — deduped
          { contact_id: 'b', invoice_date: '2026-06-21T10:00:00Z' }, // June
          { contact_id: 'c', invoice_date: '2026-07-28T10:00:00Z' }, // July
        ],
        error: null,
      },
      membership_transitions: {
        data: [{ occurred_at: '2026-07-29T08:00:00Z' }],
        error: null,
      },
    })
    const { months } = await fetchMembershipFlows(db, 'loc-1', 3, NOW)
    expect(months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07'])
    expect(months.map((m) => m.sales)).toEqual([1, 1, 1]) // the June retry did not double-count
    expect(months[2].cancellations).toBe(1)
  })

  it('buckets a late-UTC event into the next Dublin month during BST', async () => {
    const db = fakeDb({
      glofox_invoices: {
        data: [{ contact_id: 'a', invoice_date: '2026-06-30T23:30:00Z' }], // 00:30 Dublin, 1 Jul
        error: null,
      },
      membership_transitions: { data: [], error: null },
    })
    const { months } = await fetchMembershipFlows(db, 'loc-1', 3, NOW)
    expect(months.find((m) => m.month === '2026-07').sales).toBe(1)
    expect(months.find((m) => m.month === '2026-06').sales).toBe(0)
  })

  it('dedupes against a first sale outside the display window', async () => {
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
    const { months } = await fetchMembershipFlows(db, 'loc-1', 2, NOW) // window = Jun, Jul only
    expect(months.every((m) => m.sales === 0)).toBe(true)
  })

  it('nulls each series for months before its data source existed', async () => {
    const db = fakeDb({
      glofox_invoices: { data: [], error: null },
      membership_transitions: { data: [], error: null },
    })
    const { months, cancelTrackingStart } = await fetchMembershipFlows(db, 'loc-1', 5, NOW)
    expect(cancelTrackingStart).toBe(CANCEL_TRACKING_START)
    expect(months.map((m) => m.month)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
    // sales data from May 2026; cancel tracking from July 2026
    expect(months.map((m) => m.sales)).toEqual([null, null, 0, 0, 0])
    expect(months.map((m) => m.cancellations)).toEqual([null, null, null, null, 0])
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
    expect(db._calls.glofox_invoices.gte).toEqual(['invoice_date', SALES_DATA_START])
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
