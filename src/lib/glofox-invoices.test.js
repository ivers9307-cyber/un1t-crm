import { describe, it, expect } from 'vitest'
import {
  parseInvoicePayload,
  recomputeContactLifetimeValue,
} from './glofox-invoices.js'

// Sample INVOICE_UPDATED payload shape per the spec.
const SAMPLE_EVENT = {
  type: 'INVOICE_UPDATED',
  Metadata: {
    trace_id: 't-1',
    location_id: '6155764859810329ec3826b3',
    version: '1',
  },
  Timestamp: '2026-05-11T10:00:00Z',
  Payload: {
    id: 'inv_001',
    sold_by_user: { id: 'staff_1' },
    user: {
      id: 'usr_glofox_001',
      first_name: 'Cathy',
      last_name: 'Laverty',
      email: 'lavertycathy@hotmail.com',
      phone: '+353864099944',
      tax_id: '',
      address: {
        street: '', city: '', state: '', country: 'IE', postal_code: '',
      },
    },
    date: '2026-05-11T10:00:00Z',
    line_items: [
      {
        name: 'Monthly Membership',
        unit_price: 9999,
        quantity: 1,
        applied_taxes: [],
        applied_discounts: [],
        type: 'MEMBERSHIPS',
        sub_type: 'SUBSCRIPTION_PAYMENT',
      },
    ],
    total: 9999,
    currency: 'EUR',
    document_type: 'invoice',
    payment_method: 'CARD',
    status: 'PAID',
    created: '2026-05-11T10:00:00Z',
    modified: '2026-05-11T10:00:01Z',
  },
}

describe('parseInvoicePayload', () => {
  it('returns null for null / non-object input', () => {
    expect(parseInvoicePayload(null)).toBeNull()
    expect(parseInvoicePayload('string')).toBeNull()
  })

  it('returns null when invoice id is missing', () => {
    expect(parseInvoicePayload({ Payload: { user: { id: 'x' } } })).toBeNull()
    expect(parseInvoicePayload({ Payload: {} })).toBeNull()
  })

  it('extracts canonical fields from the SAMPLE_EVENT', () => {
    const out = parseInvoicePayload(SAMPLE_EVENT)
    expect(out).toMatchObject({
      id: 'inv_001',
      glofox_user_id: 'usr_glofox_001',
      user_email: 'lavertycathy@hotmail.com',
      amount_cents: 9999,
      currency: 'EUR',
      status: 'PAID',
      payment_method: 'CARD',
      document_type: 'invoice',
      line_item_subtypes: 'SUBSCRIPTION_PAYMENT',
      invoice_date: '2026-05-11T10:00:00.000Z',
    })
  })

  it('accepts the inner Payload directly (caller-pre-unwrapped)', () => {
    const out = parseInvoicePayload(SAMPLE_EVENT.Payload)
    expect(out.id).toBe('inv_001')
    expect(out.amount_cents).toBe(9999)
  })

  it('lowercases email', () => {
    const event = { ...SAMPLE_EVENT, Payload: {
      ...SAMPLE_EVENT.Payload, user: { ...SAMPLE_EVENT.Payload.user, email: 'CATHY@TEST.COM' },
    } }
    expect(parseInvoicePayload(event).user_email).toBe('cathy@test.com')
  })

  it('uppercases status (defends against Glofox sending lowercase)', () => {
    const event = { ...SAMPLE_EVENT, Payload: { ...SAMPLE_EVENT.Payload, status: 'paid' } }
    expect(parseInvoicePayload(event).status).toBe('PAID')
  })

  it('defaults missing status to UNKNOWN (row still lands)', () => {
    const event = { ...SAMPLE_EVENT, Payload: { ...SAMPLE_EVENT.Payload, status: null } }
    expect(parseInvoicePayload(event).status).toBe('UNKNOWN')
  })

  it('rolls multiple line item sub_types into a comma-separated string', () => {
    const event = { ...SAMPLE_EVENT, Payload: {
      ...SAMPLE_EVENT.Payload,
      line_items: [
        { sub_type: 'SUBSCRIPTION_PAYMENT' },
        { sub_type: 'BOOK_CLASS' },
        { sub_type: 'SUBSCRIPTION_PAYMENT' }, // duplicate dedup
      ],
    } }
    expect(parseInvoicePayload(event).line_item_subtypes).toBe('BOOK_CLASS,SUBSCRIPTION_PAYMENT')
  })

  it('handles missing line_items array gracefully', () => {
    const event = { ...SAMPLE_EVENT, Payload: { ...SAMPLE_EVENT.Payload, line_items: null } }
    expect(parseInvoicePayload(event).line_item_subtypes).toBeNull()
  })

  it('falls back date → created → modified for invoice_date', () => {
    const onlyCreated = { ...SAMPLE_EVENT, Payload: {
      ...SAMPLE_EVENT.Payload, date: null, created: '2026-04-01T00:00:00Z',
    } }
    expect(parseInvoicePayload(onlyCreated).invoice_date).toBe('2026-04-01T00:00:00.000Z')
  })

  it('returns null invoice_date when no usable timestamp', () => {
    const noDates = { ...SAMPLE_EVENT, Payload: {
      ...SAMPLE_EVENT.Payload, date: null, created: null, modified: null,
    } }
    expect(parseInvoicePayload(noDates).invoice_date).toBeNull()
  })

  it('coerces id to string (Glofox sometimes sends number)', () => {
    const numericId = { ...SAMPLE_EVENT, Payload: { ...SAMPLE_EVENT.Payload, id: 123 } }
    expect(parseInvoicePayload(numericId).id).toBe('123')
  })
})

// recomputeContactLifetimeValue uses Supabase chains we mock.
function fakeDb({ invoices = [], updateOk = true } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      if (table === 'glofox_invoices') {
        // recomputeContactLifetimeValue now pages via selectAll:
        // .select().eq().order().range() → one short page resolves the
        // whole fixture and the loop stops.
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                range: () => Promise.resolve({ data: invoices, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'contacts') {
        return {
          update(values) {
            updates.push(values)
            return {
              eq: () => Promise.resolve({ error: updateOk ? null : { message: 'fail' } }),
            }
          },
        }
      }
      return {}
    },
  }
}

describe('recomputeContactLifetimeValue', () => {
  it('returns null on no contact id / db', async () => {
    expect(await recomputeContactLifetimeValue(null, 'c1')).toBeNull()
    expect(await recomputeContactLifetimeValue(fakeDb(), null)).toBeNull()
  })

  it('aggregates only PAID invoices into lifetime_value_cents', async () => {
    const db = fakeDb({
      invoices: [
        { amount_cents: 9999, currency: 'EUR', status: 'PAID',     invoice_date: '2026-05-01T00:00:00Z' },
        { amount_cents: 9999, currency: 'EUR', status: 'PAID',     invoice_date: '2026-04-01T00:00:00Z' },
        { amount_cents: 5000, currency: 'EUR', status: 'PENDING',  invoice_date: '2026-05-10T00:00:00Z' },
        { amount_cents: 9999, currency: 'EUR', status: 'PAST_DUE', invoice_date: '2026-03-01T00:00:00Z' },
        { amount_cents: 9999, currency: 'EUR', status: 'FORGIVEN', invoice_date: '2026-02-01T00:00:00Z' },
      ],
    })
    const out = await recomputeContactLifetimeValue(db, 'c1')
    expect(out.lifetime_value_cents).toBe(19998) // 2 PAID invoices × 9999
    expect(out.lifetime_transaction_count).toBe(2)
    expect(out.lifetime_currency).toBe('EUR')
    expect(out.last_payment_at).toBe('2026-05-01T00:00:00.000Z')
  })

  it('last_invoice_at picks up the most recent ANY-status invoice', async () => {
    const db = fakeDb({
      invoices: [
        { amount_cents: 9999, status: 'PAID',     invoice_date: '2026-04-01T00:00:00Z' },
        // PENDING is later than the most recent PAID — captures
        // "Glofox last invoiced this person 2 days ago even though
        // they haven't paid".
        { amount_cents: 9999, status: 'PENDING',  invoice_date: '2026-05-09T00:00:00Z' },
      ],
    })
    const out = await recomputeContactLifetimeValue(db, 'c1')
    expect(out.last_payment_at).toBe('2026-04-01T00:00:00.000Z')
    expect(out.last_invoice_at).toBe('2026-05-09T00:00:00.000Z')
  })

  it('returns zeroed aggregates when contact has no invoices', async () => {
    const db = fakeDb({ invoices: [] })
    const out = await recomputeContactLifetimeValue(db, 'c1')
    expect(out.lifetime_value_cents).toBe(0)
    expect(out.lifetime_transaction_count).toBe(0)
    expect(out.lifetime_currency).toBeNull()
    expect(out.last_payment_at).toBeNull()
  })

  it('writes the aggregates back to the contacts row', async () => {
    const db = fakeDb({
      invoices: [{ amount_cents: 9999, currency: 'EUR', status: 'PAID', invoice_date: '2026-05-01T00:00:00Z' }],
    })
    await recomputeContactLifetimeValue(db, 'c1')
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]).toMatchObject({
      lifetime_value_cents: 9999,
      lifetime_transaction_count: 1,
      lifetime_currency: 'EUR',
    })
  })

  it('returns null on update failure (best-effort)', async () => {
    const db = fakeDb({
      invoices: [{ amount_cents: 9999, status: 'PAID', invoice_date: '2026-05-01T00:00:00Z' }],
      updateOk: false,
    })
    expect(await recomputeContactLifetimeValue(db, 'c1')).toBeNull()
  })
})
