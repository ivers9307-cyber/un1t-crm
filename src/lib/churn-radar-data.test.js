import { describe, it, expect } from 'vitest'
import { loadOverdue, loadUnpaidCharges, loadAwaitingAuth, loadRadar, loadContactArrears } from './churn-radar-data'

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

function gInvoice({ id, glofox_user_id, contact_id, amount_cents, status, invoice_date, line_item_subtypes = null, glofox_event = null }) {
  return { id, glofox_user_id, contact_id, amount_cents, status, invoice_date, line_item_subtypes, glofox_event, location_id: LOC }
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
          return [gInvoice({ id: 'pd1', glofox_user_id: 'fran', contact_id: 'c-fran', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z', line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })]
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
          return [gInvoice({ id: 'pd1', glofox_user_id: 'gus', contact_id: 'c-gus', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-01T10:00:00Z', line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })]
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
          return [gInvoice({ id: 'pd1', glofox_user_id: 'hana', contact_id: 'c-hana', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z', line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })]
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
            gInvoice({ id: 'pd1', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T10:36:00Z', line_item_subtypes: 'SUBSCRIPTION_RENEWAL' }),
            gInvoice({ id: 'pd2', glofox_user_id: 'iris', contact_id: 'c-iris', amount_cents: 9900, status: 'PAST_DUE', invoice_date: '2026-05-27T11:00:00Z', line_item_subtypes: 'SUBSCRIPTION_RENEWAL' }),
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

// ── PROFILE-ARREARS.1: per-contact arrears for the contact profile ───────────
//
// The radar's fetchPastDue aggregates the WHOLE location; the profile page needs
// ONE contact's open past-due total so an ungrouped member (the ~99% case) shows
// the SAME arrears the Overdue chase-list flags — instead of a blank "—".
// loadContactArrears must use the identical glofox_invoices columns + the shared
// nettedOutByRetry settled-retry netting, scoped to a single contact_id.

describe('loadContactArrears — per-contact profile arrears (PROFILE-ARREARS.1)', () => {
  const C = 'c-john'
  const U = 'u-john'
  const pd = (id, cents, date) => gInvoice({ id, glofox_user_id: U, contact_id: C, amount_cents: cents, status: 'PAST_DUE', invoice_date: date })
  const paid = (id, cents, date) => gInvoice({ id, glofox_user_id: U, contact_id: C, amount_cents: cents, status: 'PAID', invoice_date: date })

  it('sums the open past-due fees a single ungrouped contact owes (John Heenan case)', async () => {
    // 6 distinct late-cancel / no-show fees = €55. The only same-amount PAID
    // (the €5 on 22 Jan) is ~4 months from the €5 PAST_DUE → far outside the
    // ±1-day retry window → nothing nets out → the profile must show €55.
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') return [
          pd('f1', 1000, '2026-05-14T06:00:00Z'),
          pd('f2', 500, '2026-05-31T08:00:00Z'),
          pd('f3', 1000, '2026-06-07T09:00:00Z'),
          pd('f4', 1000, '2026-06-13T06:00:00Z'),
          pd('f5', 1000, '2026-06-17T07:00:00Z'),
          pd('f6', 1000, '2026-06-26T06:00:00Z'),
        ]
        if (state.status === 'PAID') return [paid('p1', 500, '2026-01-22T10:00:00Z')]
        return []
      },
    })
    const res = await loadContactArrears(db, C)
    expect(res.arrearsCents).toBe(5500)
    expect(res.count).toBe(6)
  })

  it('nets a settled card-retry (same member, same amount, within ±1 day) out of the figure', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') return [pd('pd1', 9900, '2026-05-27T10:36:00Z')]
        if (state.status === 'PAID') return [paid('p1', 9900, '2026-05-27T10:40:00Z')]
        return []
      },
    })
    const res = await loadContactArrears(db, C)
    expect(res.arrearsCents).toBe(0)
    expect(res.count).toBe(0)
  })

  it('returns zeros for a contact with no invoices', async () => {
    const db = makeDb({ glofox_invoices: () => [] })
    const res = await loadContactArrears(db, C)
    expect(res).toEqual({ arrearsCents: 0, count: 0 })
  })

  it('returns zeros (never throws) when the invoice query errors', async () => {
    const db = makeDb({ glofox_invoices: () => { throw new Error('boom') } })
    const res = await loadContactArrears(db, C)
    expect(res).toEqual({ arrearsCents: 0, count: 0 })
  })
})

// ── OWED-PENDING.1 / AWAITING-AUTH.1: PENDING custom-charge fees ──────────────
// A no-show / late-cancel fee that's been applied but not yet collected sits
// PENDING in Glofox ("awaiting authorization"). It is provisional — it expires
// if the customer never pays — so it does NOT count as owed anywhere: not on the
// contact-profile arrears figure/pill (loadContactArrears) and not on the churn
// radar's Overdue or Unpaid-charges tabs. It surfaces only in its own
// Awaiting-authorization tab.
describe('PENDING custom-charge fees — provisional, never counted as owed (OWED-PENDING.1 / AWAITING-AUTH.1)', () => {
  it('loadContactArrears counts CONFIRMED PAST_DUE only — never a PENDING "awaiting authorization" fee', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') return [gInvoice({ id: 'pd', glofox_user_id: 'cf', contact_id: 'c-claire', amount_cents: 1000, status: 'PAST_DUE', invoice_date: '2026-05-03T00:00:00Z' })]
        if (state.status === 'PENDING') return [
          gInvoice({ id: 'fee', glofox_user_id: 'cf', contact_id: 'c-claire', amount_cents: 1000, status: 'PENDING', invoice_date: '2026-05-26T00:00:00Z', line_item_subtypes: 'CUSTOM_CHARGE' }),
          gInvoice({ id: 'sub', glofox_user_id: 'cf', contact_id: 'c-claire', amount_cents: 20900, status: 'PENDING', invoice_date: '2026-05-26T00:00:00Z', line_item_subtypes: 'SUBSCRIPTION_PAYMENT' }),
        ]
        return []
      },
    })
    const res = await loadContactArrears(db, 'c-claire')
    expect(res.arrearsCents).toBe(1000) // €10 PAST_DUE only; the €10 pending fee no longer counts as owed
    expect(res.count).toBe(1)
  })

  it('splits a small PAST_DUE (Unpaid charges) from a PENDING fee (Awaiting authorization)', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') return [gInvoice({ id: 'pd', glofox_user_id: 'cf', contact_id: 'c-claire', amount_cents: 1000, status: 'PAST_DUE', invoice_date: '2026-05-03T00:00:00Z', line_item_subtypes: 'CUSTOM_CHARGE' })]
        if (state.status === 'PENDING') return [gInvoice({ id: 'fee', glofox_user_id: 'cf', contact_id: 'c-claire', amount_cents: 1000, status: 'PENDING', invoice_date: '2026-05-26T00:00:00Z', line_item_subtypes: 'CUSTOM_CHARGE' })]
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-claire', name: 'Claire' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0) // a €10 fee is not a membership payment → not on the chase-list
    // Unpaid charges = the €10 confirmed PAST_DUE only (pending no longer merged in).
    const { charges, summary } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(1)
    expect(charges[0].contactId).toBe('c-claire')
    expect(charges[0].invoiceCount).toBe(1)
    expect(charges[0].amountOwedCents).toBe(1000)
    expect(summary.totalValueCents).toBe(1000)
    // Awaiting authorization = the €10 PENDING fee only.
    const { charges: awaiting, summary: aSummary } = await loadAwaitingAuth(db, LOC, NOW)
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0].contactId).toBe('c-claire')
    expect(awaiting[0].invoiceCount).toBe(1)
    expect(awaiting[0].amountOwedCents).toBe(1000)
    expect(aSummary.totalValueCents).toBe(1000)
  })

  it('surfaces a PENDING-only contact (no past-due at all) in Awaiting authorization', async () => {
    // Guards the loadArrearsRows id-union: a contact with ONLY a pending fee has
    // no PAST_DUE row, so their contact row is fetched via awaitingAuthById.keys()
    // — otherwise buildOverdue would have no contact to build a row from.
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PENDING') return [gInvoice({ id: 'fee', glofox_user_id: 'pf', contact_id: 'c-pen', amount_cents: 1500, status: 'PENDING', invoice_date: '2026-05-20T00:00:00Z', line_item_subtypes: 'CUSTOM_CHARGE' })]
        return [] // no PAST_DUE, no PAID
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-pen', name: 'Pending Only' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(0)
    const { charges: awaiting, summary } = await loadAwaitingAuth(db, LOC, NOW)
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0].contactId).toBe('c-pen')
    expect(awaiting[0].name).toBe('Pending Only')
    expect(awaiting[0].amountOwedCents).toBe(1500)
    expect(summary.totalValueCents).toBe(1500)
  })

  it('AWAITING-AUTH.2 — a PENDING charge of ANY type (a class booking) shows in Awaiting authorization, not just custom-charge fees', async () => {
    // Cian Gormley's case: a PAYG class booking awaiting authorization, stored
    // PENDING (BOOK_CLASS). The old custom-charge-only filter hid it from the
    // tab; it must now surface there and never count as owed.
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PENDING') return [gInvoice({ id: 'bc', glofox_user_id: 'cg', contact_id: 'c-cian', amount_cents: 2500, status: 'PENDING', invoice_date: '2026-05-08T00:00:00Z', line_item_subtypes: 'BOOK_CLASS' })]
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-cian', name: 'Cian' })],
    })
    const { charges: awaiting } = await loadAwaitingAuth(db, LOC, NOW)
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0].contactId).toBe('c-cian')
    expect(awaiting[0].amountOwedCents).toBe(2500)
    // never a debt: absent from Overdue and Unpaid charges
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    const { charges: unpaid } = await loadUnpaidCharges(db, LOC, NOW)
    expect(unpaid).toHaveLength(0)
  })

  it('keeps a failed renewal on Overdue and its PENDING fee under Awaiting authorization', async () => {
    const db = makeDb({
      glofox_invoices: (state) => {
        if (state.status === 'PAST_DUE') return [gInvoice({ id: 'pd', glofox_user_id: 'cf', contact_id: 'c-big', amount_cents: 20900, status: 'PAST_DUE', invoice_date: '2026-05-03T00:00:00Z', line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })]
        if (state.status === 'PENDING') return [gInvoice({ id: 'fee', glofox_user_id: 'cf', contact_id: 'c-big', amount_cents: 1000, status: 'PENDING', invoice_date: '2026-05-26T00:00:00Z', line_item_subtypes: 'CUSTOM_CHARGE' })]
        return []
      },
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-big', name: 'Big Debt' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0].amountOwedCents).toBe(20900) // PAST_DUE only — pending excluded from Overdue
    // No confirmed past-due non-membership charge → Unpaid charges is empty (pending moved out).
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(0)
    // The pending fee is under Awaiting authorization instead.
    const { charges: awaiting } = await loadAwaitingAuth(db, LOC, NOW)
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0].contactId).toBe('c-big')
    expect(awaiting[0].amountOwedCents).toBe(1000)
  })
})

// ── ARREARS-TYPE.1: Overdue vs Unpaid charges by CHARGE TYPE ─────────────────
// Richard's rule (2026-08-23): Overdue = failed MEMBERSHIP payments only;
// Unpaid charges = every other failing transaction at ANY amount; pending stays
// in Awaiting authorization. The €50 line is gone.
describe('Overdue vs Unpaid charges — by charge type (ARREARS-TYPE.1)', () => {
  const PD = (over) => gInvoice({ status: 'PAST_DUE', invoice_date: '2026-05-03T00:00:00Z', ...over })

  it('a failed €380 class pack (lone UPFRONT_PAYMENT) is an Unpaid charge, not Overdue', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'pack', glofox_user_id: 'u1', contact_id: 'c-pack', amount_cents: 38000, line_item_subtypes: 'UPFRONT_PAYMENT' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-pack', name: 'Pack Buyer' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    const { charges, summary } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ contactId: 'c-pack', amountOwedCents: 38000, invoiceCount: 1 })
    expect(summary).toMatchObject({ total: 1, totalValueCents: 38000 })
  })

  it('a failed €25 renewal is Overdue, not an Unpaid charge', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'ren', glofox_user_id: 'u2', contact_id: 'c-ren', amount_cents: 2500, line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-ren', name: 'Small Renewal' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({ contactId: 'c-ren', amountOwedCents: 2500 })
    expect(summary.totalValueCents).toBe(2500)
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(0)
  })

  it('a failed first payment at signup (SUBSCRIPTION_PAYMENT + €0 UPFRONT_PAYMENT) is Overdue', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'signup', glofox_user_id: 'u3', contact_id: 'c-new', amount_cents: 9900, line_item_subtypes: 'SUBSCRIPTION_PAYMENT,UPFRONT_PAYMENT' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-new', name: 'New Signup' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue.map((r) => r.contactId)).toEqual(['c-new'])
  })

  it('a backfilled custom charge (no line items, raw_payload.candidate.glofoxEvent) is an Unpaid charge whatever its description or amount', async () => {
    // The €467 "Membership"-described custom charge from the June backfill.
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: '8e04230d', glofox_user_id: 'u4', contact_id: 'c-cc', amount_cents: 46700, line_item_subtypes: null, glofox_event: 'custom_charge', invoice_date: '2026-01-27T19:45:00Z' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-cc', name: 'Custom Charge' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges.map((r) => [r.contactId, r.amountOwedCents])).toEqual([['c-cc', 46700]])
  })

  it('a backfilled failed renewal (glofoxEvent subscription_payment_failed) is Overdue', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'bf-ren', glofox_user_id: 'u5', contact_id: 'c-bf', amount_cents: 19900, line_item_subtypes: null, glofox_event: 'subscription_payment_failed' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-bf', name: 'Backfilled Renewal' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue.map((r) => r.contactId)).toEqual(['c-bf'])
  })

  it('the SAME contact with a failed renewal AND a failed fee appears in BOTH tabs with separate amounts', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [
            PD({ id: 'ren', glofox_user_id: 'u6', contact_id: 'c-both', amount_cents: 19900, line_item_subtypes: 'SUBSCRIPTION_RENEWAL', invoice_date: '2026-05-01T00:00:00Z' }),
            PD({ id: 'fee', glofox_user_id: 'u6', contact_id: 'c-both', amount_cents: 1000, line_item_subtypes: 'CUSTOM_CHARGE', invoice_date: '2026-05-20T00:00:00Z' }),
          ]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-both', name: 'Both' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({ contactId: 'c-both', amountOwedCents: 19900, invoiceCount: 1 })
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ contactId: 'c-both', amountOwedCents: 1000, invoiceCount: 1 })
  })

  it('loadRadar summary badges match the tabs, and a fee-only contact still classifies as overdue (pill) without being on the chase-list', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [
            PD({ id: 'ren', glofox_user_id: 'u7', contact_id: 'c-r', amount_cents: 19900, line_item_subtypes: 'SUBSCRIPTION_RENEWAL' }),
            PD({ id: 'pack', glofox_user_id: 'u8', contact_id: 'c-p', amount_cents: 38000, line_item_subtypes: 'UPFRONT_PAYMENT' }),
            PD({ id: 'fee', glofox_user_id: 'u9', contact_id: 'c-f', amount_cents: 1000, line_item_subtypes: 'CUSTOM_CHARGE' }),
          ]
        : state.status === 'PENDING'
          ? [gInvoice({ id: 'pend', glofox_user_id: 'u10', contact_id: 'c-a', amount_cents: 500, status: 'PENDING', invoice_date: '2026-05-26T00:00:00Z', line_item_subtypes: 'CUSTOM_CHARGE' })]
          : [],
      churn_radar_actions: [],
      contacts: ['c-r', 'c-p', 'c-f', 'c-a'].map((id) => contact({ id })),
      person_groups: [],
    })
    const { radar, summary } = await loadRadar(db, LOC, NOW)
    expect(summary).toMatchObject({
      overdue: 1, overdueValueCents: 19900,
      unpaidCharges: 2, unpaidChargesValueCents: 39000,
      awaitingAuth: 1, awaitingAuthValueCents: 500,
    })
    // Every contact with ANY open PAST_DUE is pulled off the at-risk list (ids/byId unchanged).
    expect(radar.map((r) => r.contactId)).not.toContain('c-f')
  })
})

// ── CHURN-RADAR-PERSON-AWARE: loadRadar person-group integration ──────────────
//
// Tests that `applyPersonRollup` is wired correctly into the three loaders.
// We extend the mock builder so it tracks both .eq() filters and .not() calls,
// allowing dispatch to differentiate between:
//   - contacts loaded via .eq('location_id') for member sweep (key: 'contacts')
//   - contacts loaded via .eq('location_id') + .not('person_group_id', 'is', null)
//     for the cross-status activity path (key: 'contacts:grouped')
//   - person_groups loaded via .eq('location_id') (key: 'person_groups:location')
//   - contacts loaded via .in('id', ...) for the overdue path (key: 'contacts:id')

function makeDbPersonAware(tables) {
  function builder(table) {
    const state = { table, inCol: null, notCol: null, eqFilters: {}, single: false }
    const b = {
      select() { return b },
      eq(col, val) { state.eqFilters[col] = val; return b },
      not(col) { state.notCol = col; return b },
      in(col) { state.inCol = col; return b },
      gte() { return b },
      order() { return b },
      range() { return b },
      limit() { return b },
      maybeSingle() { state.single = true; return b },
      then(resolve, reject) {
        let rows
        try {
          // Determine dispatch key based on which filters were set.
          // Priority: explicit in() col > not(col) > table default.
          let key
          if (state.inCol) {
            key = `${table}:${state.inCol}`
          } else if (state.notCol) {
            // .not('person_group_id', ...) on contacts = cross-status grouped load
            key = `${table}:grouped`
          } else {
            // person_groups with .eq('location_id') goes to 'person_groups:location'
            // for disambiguation from any other person_groups query
            if (table === 'person_groups' && state.eqFilters.location_id) {
              key = 'person_groups:location'
            } else {
              key = table
            }
          }
          const src = tables[key] !== undefined ? tables[key] : tables[table]
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

// A dormant-member contact shape — last_attended ~600 days ago, zero 30d
// attendance, has a live time-based membership. Should be flagged at-risk
// normally (gone-quiet > 45d → actually 'out' in buildRadar because
// QUIET_MAX_DAYS=45; so it won't appear in radar rows — perfect for the Mark
// case: without rollup he never appears in radar but still counts in summary;
// with rollup the combined activity moves him to active+attended, so scorer
// picks him up as low-risk but the rollup also replaces last_attended so
// classifyContact sees footprint → 'active', then gone-quiet window checks
// days since last attended → 3 days < 14 = no signals → NOT at-risk).
//
// Actually the simpler read: with recent activity (3 days), classifyContact
// sees footprint → 'active'. scoreMember checks each detector — gone_quiet
// needs ≥14 days since last attended (3d < 14 → no signal), disengaging
// needs total_attended_30d ≥ 4 (6 > 4) AND total_attended_7d === 0 (we leave
// 7d at 0 — so disengaging WOULD fire. Let's give total_attended_7d = 1 to
// prevent it). So with combined: 6 attended/30d, 1/7d, last_attended 3d ago
// → zero signals → scoreMember returns null → NOT in radar list.
// Without rollup the dormant member has last_attended 600d ago → classifyContact
// → 'active' (has footprint), scoreMember → gone_quiet fires (600d > 45d →
// QUIET_MAX_DAYS=45 → actually 45d is the MAX; > MAX means they're off the
// radar too). Let's use 30 days for dormant — in window (14–45d) → scored.
// That way without rollup they appear at-risk, with rollup they don't.

function dormantMember({ id, name = 'Mark', person_group_id = null } = {}) {
  return {
    id, name,
    location_id: LOC,
    glofox_membership_status: 'member',
    glofox_membership_type: 'time',
    glofox_membership_plan: 'Monthly Membership',
    glofox_membership_state: 'active',
    glofox_membership_expiry: null,
    glofox_membership_price_cents: 9900,
    glofox_billing_interval: '1 month',
    trial_credits_remaining: null,
    // 30 days ago — inside the gone-quiet window (14–45d) → at-risk without rollup
    last_attended_at: new Date(NOW - 30 * 86_400_000).toISOString(),
    last_booked_at: null,
    last_payment_at: new Date(NOW - 5 * 86_400_000).toISOString(),
    total_attended_30d: 0,
    total_attended_7d: 0,
    total_noshow_30d: 0,
    total_bookings_30d: 0,
    joined_at: new Date(NOW - 365 * 86_400_000).toISOString(),
    lifetime_value_cents: 50000,
    person_group_id,
  }
}

function activeClasspassContact({ id, person_group_id }) {
  // A classpass_payg contact (NOT in MEMBER_STATUSES) sharing the same group.
  // Attended 3 days ago with 6/30d sessions.
  return {
    id, person_group_id,
    last_attended_at: new Date(NOW - 3 * 86_400_000).toISOString(),
    last_booked_at: new Date(NOW - 3 * 86_400_000).toISOString(),
    total_attended_30d: 6,
    total_attended_7d: 1,
    total_noshow_30d: 0,
  }
}

const GROUP_ID = 'group-mark'

describe('loadRadar — person-group-aware (CHURN-RADAR-PERSON-AWARE)', () => {
  // ── Mark case ────────────────────────────────────────────────────────────
  // The key test: a dormant member contact (in the at-risk window) whose
  // person group has an active classpass_payg account. After rollup, the
  // combined activity shows recent attendance → NOT at-risk.
  it('Mark case — dormant member with active ClassPass sibling is NOT in radar', async () => {
    const markMember = dormantMember({ id: 'c-mark-member', person_group_id: GROUP_ID })
    const markClasspass = activeClasspassContact({ id: 'c-mark-cp', person_group_id: GROUP_ID })

    const db = makeDbPersonAware({
      // fetchMembers returns the dormant member (only member-status contacts)
      contacts: [markMember],
      // applyPersonRollup — person_groups location-scoped load
      'person_groups:location': [{ id: GROUP_ID, primary_contact_id: 'c-mark-member', location_id: LOC }],
      // applyPersonRollup — cross-status grouped contacts (location-scoped, not null person_group_id)
      'contacts:grouped': [markMember, markClasspass],
      // Other tables used by loadRadar
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    const { radar, summary } = await loadRadar(db, LOC, NOW)

    // With combined activity (3d recent, 6/30d), gone-quiet doesn't fire
    // (3d < 14d threshold) and disengaging doesn't fire (total_attended_30d ≥ 4).
    // scoreMember returns null → Mark is NOT in the at-risk list.
    const markRow = radar.find((r) => r.contactId === 'c-mark-member')
    expect(markRow).toBeUndefined()

    // But Mark IS in the active base (classifyContact sees footprint → 'active')
    expect(summary.activeBase).toBeGreaterThanOrEqual(1)
  })

  // ── Dedup: two member accounts in the same group ─────────────────────────
  it('dedup — two member contacts in the same group count as ONE person in radar', async () => {
    const memberA = dormantMember({ id: 'c-dedup-a', name: 'Twin A', person_group_id: GROUP_ID })
    const memberB = dormantMember({ id: 'c-dedup-b', name: 'Twin B', person_group_id: GROUP_ID })

    const db = makeDbPersonAware({
      contacts: [memberA, memberB],
      'person_groups:location': [{ id: GROUP_ID, primary_contact_id: 'c-dedup-a', location_id: LOC }],
      // Both members in the cross-status fetch; combined = 0+0 = 0 attended 30d,
      // last_attended stays 30 days ago → at-risk as one person, not two.
      'contacts:grouped': [memberA, memberB],
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    const { radar, summary } = await loadRadar(db, LOC, NOW)

    // Active base should count them as ONE person (deduplicated to primary c-dedup-a)
    expect(summary.activeBase).toBe(1)

    // The radar list should show at most 1 row for this group (the primary)
    const dedupRows = radar.filter((r) => r.contactId === 'c-dedup-a' || r.contactId === 'c-dedup-b')
    expect(dedupRows.length).toBeLessThanOrEqual(1)
    // The non-primary 'c-dedup-b' should never appear
    expect(radar.find((r) => r.contactId === 'c-dedup-b')).toBeUndefined()
  })

  // ── Ungrouped unaffected ─────────────────────────────────────────────────
  it('ungrouped — a dormant member with no person_group_id still appears at-risk', async () => {
    // No person_group_id — goes through unchanged via the fast path
    const ungroupedMember = dormantMember({ id: 'c-ungrouped', person_group_id: null })

    const db = makeDbPersonAware({
      contacts: [ungroupedMember],
      // person_groups + cross-status contacts should not be called (fast path: no grouped rows)
      // but we leave them empty just in case to avoid false errors
      'person_groups:location': [],
      'contacts:grouped': [],
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    const { radar } = await loadRadar(db, LOC, NOW)

    // Dormant member (30d no attendance) is in gone-quiet window → at-risk
    const row = radar.find((r) => r.contactId === 'c-ungrouped')
    expect(row).toBeDefined()
    expect(row.signals.some((s) => s.key === 'gone_quiet')).toBe(true)
  })

  // ── Degrade-safe ─────────────────────────────────────────────────────────
  it('degrade-safe — person_groups query error → loadRadar still returns a result', async () => {
    const markMember = dormantMember({ id: 'c-mark-err', person_group_id: GROUP_ID })

    const db = makeDbPersonAware({
      contacts: [markMember],
      // Simulate person_groups throwing an error
      'person_groups:location': () => { throw new Error('DB exploded') },
      'contacts:grouped': [],
      churn_radar_actions: [],
      glofox_invoices: [],
      churn_radar_snapshots: [],
    })

    // Should not throw — degrades gracefully using raw members
    const { summary } = await loadRadar(db, LOC, NOW)

    // The result uses raw rows (no dedup) — Mark appears at-risk as before
    expect(summary.activeBase).toBeGreaterThanOrEqual(1)
    expect(typeof summary.atRisk).toBe('number')
    // No exception should be thrown
  })
})
