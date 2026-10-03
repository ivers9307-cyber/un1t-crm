// PAYLINK.5 — POST /api/churn-radar/action, action:'payment_reminder'.
//
// Coverage:
//   (a) fresh enrolment — the PAST_DUE glofox_invoices select is ordered
//       newest-first, capturePaymentForRun is called with the newest
//       membership invoice's id + glofox_user_id, and enrolContacts
//       receives metadata: { payment }.
//   (b) enrolContacts resolves { enrolled: 0 } (already mid-sequence) —
//       refreshActiveRunPayment is called with { sequenceId, contactId,
//       payment } and the response carries already_enrolled + refreshed.
//
// isMembershipInvoice (@/lib/glofox-arrears) is real; paymentTroubleKind
// (@/lib/churn-radar) is stubbed to 'overdue' since the trouble-kind
// derivation itself is covered by src/lib/churn-radar's own tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => USER),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/sequences', () => ({ enrolContacts: vi.fn() }))
vi.mock('@/lib/dunning-payment', () => ({
  capturePaymentForRun: vi.fn(),
  refreshActiveRunPayment: vi.fn(),
}))
vi.mock('@/lib/churn-radar', () => ({ paymentTroubleKind: vi.fn(() => 'overdue') }))

import { POST } from './route.js'
import { enrolContacts } from '@/lib/sequences'
import { capturePaymentForRun, refreshActiveRunPayment } from '@/lib/dunning-payment'

const USER = { id: 'user-1', activeLocation: { id: 'loc-1' } }
const CONTACT = {
  id: 'c1', name: 'Emma Byrne', first_name: 'Emma', location_id: 'loc-1',
  wa_phone: null, phone: null,
}
const SEQ = { id: 'seq-1', name: 'Overdue dunning', status: 'active', location_id: 'loc-1', trigger_type: 'manual' }
const PAYMENT = { invoice_id: 'inv-new', link: 'https://pay.example/inv-new', link_suffix: 'inv-new', amount: '€49', currency: 'EUR', retriable: true, fetched_at: 't', error: null }

// Two PAST_DUE membership invoices — pre-sorted newest first, the way the
// real `.order('invoice_date', { ascending: false })` would return them.
const INVOICES = [
  { id: 'inv-new', line_item_subtypes: 'SUBSCRIPTION_RENEWAL', invoice_date: '2026-09-10T00:00:00Z', glofox_user_id: 'gfx-1' },
  { id: 'inv-old', line_item_subtypes: 'SUBSCRIPTION_RENEWAL', invoice_date: '2026-08-01T00:00:00Z', glofox_user_id: 'gfx-1' },
]

// Generic per-table canned-result chain, recording every builder call so
// ordering/filters can be asserted on.
let calls
let db
function mockDb(tables) {
  return {
    from: (table) => {
      const result = Object.prototype.hasOwnProperty.call(tables, table)
        ? tables[table]
        : { data: null, error: null }
      const chain = {}
      const record = (method, args) => { calls.push({ table, method, args }); return chain }
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = (...args) => record(m, args)
      chain.insert = (row) => { calls.push({ table, method: 'insert', args: [row] }); return Promise.resolve({ data: null, error: null }) }
      chain.maybeSingle = () => Promise.resolve(result)
      chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      return chain
    },
  }
}

function req(body) {
  return new Request('http://localhost/api/churn-radar/action', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  db = mockDb({
    contacts: { data: CONTACT, error: null },
    locations: { data: { dunning_sequence_id: 'seq-1' }, error: null },
    glofox_invoices: { data: INVOICES, error: null },
    email_sequences: { data: SEQ, error: null },
  })
})

describe('POST /api/churn-radar/action — payment_reminder pay-link capture', () => {
  it('(a) fresh enrolment: captures the newest membership invoice and enrols with metadata.payment', async () => {
    capturePaymentForRun.mockResolvedValue({ payment: PAYMENT })
    enrolContacts.mockResolvedValue({ enrolled: 1 })

    const res = await POST(req({ contact_id: 'c1', action: 'payment_reminder' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, data: { action: 'payment_reminder' } })
    expect(json.data.already_enrolled).toBeUndefined()

    // Ordered newest-first, nulls last (a null invoice_date can never win).
    expect(calls).toContainEqual({ table: 'glofox_invoices', method: 'order', args: ['invoice_date', { ascending: false, nullsFirst: false }] })

    // capturePaymentForRun got the NEWEST invoice's id + glofox_user_id.
    expect(capturePaymentForRun).toHaveBeenCalledWith(db, {
      locationId: 'loc-1', contactId: 'c1', invoiceId: 'inv-new', glofoxUserId: 'gfx-1',
    })

    // enrolContacts carries the captured payment as metadata.
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 'seq-1',
      contactIds: ['c1'],
      metadata: { payment: PAYMENT },
    }))

    expect(refreshActiveRunPayment).not.toHaveBeenCalled()
  })

  it('(b) already mid-sequence: refreshes the live run\'s payment and reports refreshed', async () => {
    capturePaymentForRun.mockResolvedValue({ payment: PAYMENT })
    enrolContacts.mockResolvedValue({ enrolled: 0 })
    refreshActiveRunPayment.mockResolvedValue({ refreshed: 1 })

    const res = await POST(req({ contact_id: 'c1', action: 'payment_reminder' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(refreshActiveRunPayment).toHaveBeenCalledWith(db, {
      sequenceId: 'seq-1', contactId: 'c1', payment: PAYMENT,
    })
    expect(json).toMatchObject({
      success: true,
      data: { action: 'payment_reminder', already_enrolled: true, refreshed: 1 },
    })

    // Idempotent no-op — no audit row written.
    expect(calls.some((c) => c.table === 'churn_radar_actions' && c.method === 'insert')).toBe(false)
  })

  it('(c) PAYLINK.5b — a slipping click with no PAST_DUE invoice never refreshes a live run: refreshed stays 0, refreshActiveRunPayment is not called', async () => {
    db = mockDb({
      contacts: { data: CONTACT, error: null },
      locations: { data: { dunning_sequence_id: 'seq-1' }, error: null },
      glofox_invoices: { data: [], error: null }, // nothing PAST_DUE — a "slipping" member
      email_sequences: { data: SEQ, error: null },
    })
    capturePaymentForRun.mockResolvedValue({ payment: { invoice_id: null, link: null, error: 'no_invoice_id' } })
    enrolContacts.mockResolvedValue({ enrolled: 0 })

    const res = await POST(req({ contact_id: 'c1', action: 'payment_reminder' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    // capturePaymentForRun still runs (with no invoice), but nothing calls
    // the library refresh — there's nothing to point the live run at.
    expect(refreshActiveRunPayment).not.toHaveBeenCalled()
    expect(json).toMatchObject({
      success: true,
      data: { action: 'payment_reminder', already_enrolled: true, refreshed: 0 },
    })
    expect(json.data.reason).toBeUndefined()
  })

  it('(d) PAYLINK.5b — an invoice read error surfaces as 502, before any Glofox call or enrol', async () => {
    db = mockDb({
      contacts: { data: CONTACT, error: null },
      locations: { data: { dunning_sequence_id: 'seq-1' }, error: null },
      glofox_invoices: { data: null, error: { message: 'boom' } },
      email_sequences: { data: SEQ, error: null },
    })

    const res = await POST(req({ contact_id: 'c1', action: 'payment_reminder' }))
    const json = await res.json()

    expect(res.status).toBe(502)
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/boom/)
    expect(capturePaymentForRun).not.toHaveBeenCalled()
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('(e) PAYLINK.5b — a newer non-membership fee never outranks the newest membership invoice', async () => {
    db = mockDb({
      contacts: { data: CONTACT, error: null },
      locations: { data: { dunning_sequence_id: 'seq-1' }, error: null },
      glofox_invoices: {
        data: [
          // A CUSTOM_CHARGE fee dated AFTER the membership invoice — not a
          // membership debt, so it must never become newestDebt.
          { id: 'inv-fee', line_item_subtypes: 'CUSTOM_CHARGE', invoice_date: '2026-09-11T00:00:00Z', glofox_user_id: 'gfx-1' },
          ...INVOICES,
        ],
        error: null,
      },
      email_sequences: { data: SEQ, error: null },
    })
    capturePaymentForRun.mockResolvedValue({ payment: PAYMENT })
    enrolContacts.mockResolvedValue({ enrolled: 1 })

    await POST(req({ contact_id: 'c1', action: 'payment_reminder' }))

    expect(capturePaymentForRun).toHaveBeenCalledWith(db, {
      locationId: 'loc-1', contactId: 'c1', invoiceId: 'inv-new', glofoxUserId: 'gfx-1',
    })
  })

  it('(f) PAYLINK.5b — the refresh reason is passed through onto the response', async () => {
    capturePaymentForRun.mockResolvedValue({ payment: PAYMENT })
    enrolContacts.mockResolvedValue({ enrolled: 0 })
    refreshActiveRunPayment.mockResolvedValue({ refreshed: 0, reason: 'kept_existing_link' })

    const res = await POST(req({ contact_id: 'c1', action: 'payment_reminder' }))
    const json = await res.json()

    expect(json.data).toMatchObject({ already_enrolled: true, refreshed: 0, reason: 'kept_existing_link' })
  })
})
