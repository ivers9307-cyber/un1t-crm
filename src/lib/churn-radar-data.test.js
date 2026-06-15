import { describe, it, expect } from 'vitest'
import { loadOverdue } from './churn-radar-data'

// ARREARS-NETTING.1 (Fix B) — the live Overdue feature must net cross-
// invoice-id payment retries out of the chase-list + total, the same way the
// arrears tool does. A PAST_DUE `glofox_invoices` row whose member
// (glofox_user_id) has a same-`amount_cents` PAID row within ±7 days is a
// settled retry and must NOT appear in Overdue.
//
// These exercise the full data path (fetchPastDue → netting → buildOverdue →
// splitArrears) through a small chainable Supabase mock. The pure netting
// itself is covered exhaustively in arrears-retry-netting.test.js.

// A thenable query builder that records .from(table) + the .eq('status', …)
// filter and resolves to a per-(table, status) row set. Every chain method
// returns `this`; awaiting resolves { data, error }.
function makeDb(tables) {
  function builder(table) {
    const state = { table, status: undefined, single: false }
    const b = {
      select() { return b },
      eq(col, val) { if (col === 'status') state.status = val; return b },
      not() { return b },
      in() { return b },
      gte() { return b },
      order() { return b },
      range() { return b },
      limit() { return b },
      maybeSingle() { state.single = true; return b },
      then(resolve, reject) {
        let rows
        try {
          const src = tables[state.table]
          rows = typeof src === 'function' ? src(state) : (src || [])
        } catch (e) { return Promise.resolve().then(() => reject(e)) }
        const value = state.single ? { data: rows[0] || null, error: null } : { data: rows, error: null }
        return Promise.resolve(value).then(resolve, reject)
      },
    }
    return b
  }
  return { from: (table) => builder(table) }
}

const LOC = 'loc-1'
// Use a fixed "now" so daysOverdue etc. are deterministic.
const NOW = Date.parse('2026-06-01T00:00:00Z')

function gInvoice({ id, glofox_user_id, contact_id, amount_cents, status, invoice_date }) {
  return { id, glofox_user_id, contact_id, amount_cents, status, invoice_date, location_id: LOC }
}
function contact({ id, name = 'Member' }) {
  return {
    id, name,
    glofox_membership_status: 'member',
    glofox_membership_type: 'time',
    glofox_membership_plan: 'Monthly Membership',
    last_attended_at: null,
    last_payment_at: null,
  }
}

describe('loadOverdue — retry netting (Fix B)', () => {
  it('excludes a PAST_DUE invoice settled by a same-member same-amount PAID within ±7 days', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [gInvoice({ id: 'pd1', glofox_user_id: 'fran', contact_id: 'c-fran', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z' })]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'fran', contact_id: 'c-fran', amount_cents: 9900, status: 'PAID', invoice_date: '2026-05-27T10:40:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-fran', name: 'Fran' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    expect(summary.total).toBe(0)
    expect(summary.totalValueCents).toBe(0)
  })

  it('keeps a PAST_DUE invoice whose only same-amount PAID is 10 days away', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [gInvoice({ id: 'pd1', glofox_user_id: 'gus', contact_id: 'c-gus', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-01T10:00:00Z' })]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'gus', contact_id: 'c-gus', amount_cents: 9900, status: 'PAID', invoice_date: '2026-05-11T10:00:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-gus', name: 'Gus' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].contactId).toBe('c-gus')
    expect(summary.totalValueCents).toBe(9900)
  })

  it('keeps a PAST_DUE invoice when the in-window PAID is a different amount', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [gInvoice({ id: 'pd1', glofox_user_id: 'hana', contact_id: 'c-hana', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z' })]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'hana', contact_id: 'c-hana', amount_cents: 4000, status: 'PAID', invoice_date: '2026-05-27T10:40:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-hana', name: 'Hana' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].contactId).toBe('c-hana')
  })

  it('nets only one of two identical PAST_DUE invoices against a single PAID retry', async () => {
    // Same member, two distinct €99 PAST_DUE rows in-window, one PAID retry.
    // One nets out; the other remains — its €99 still owed, so it shows in Overdue.
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') {
          return [
            gInvoice({ id: 'pd1', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z' }),
            gInvoice({ id: 'pd2', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T11:00:00Z' }),
          ]
        }
        if (state.status === 'PAID') {
          return [gInvoice({ id: 'p1', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAID', invoice_date: '2026-05-27T10:40:00Z' })]
        }
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-iris', name: 'Iris' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].contactId).toBe('c-iris')
    // Only the un-netted invoice's amount remains.
    expect(summary.totalValueCents).toBe(9900)
    expect(overdue[0].invoiceCount).toBe(1)
  })
})
