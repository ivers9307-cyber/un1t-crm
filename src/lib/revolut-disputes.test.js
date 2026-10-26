import { describe, it, expect, vi } from 'vitest'

const sendOpsAlert = vi.fn(async () => ({ channel: 'email' }))
vi.mock('./ops-alerts', () => ({ sendOpsAlert: (...a) => sendOpsAlert(...a) }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

import { resolveDisputeSource, disputeRow, noteDisputeOnOrder, alertStaffOfDispute } from './revolut-disputes'

// Minimal db: results keyed by table; records updates.
function fakeDb(results, updates = []) {
  return {
    updates,
    from(table) {
      const r = results[table] ?? { data: [], error: null }
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: async () => r,
        maybeSingle: async () => r,
        update: (u) => ({ eq: async () => { updates.push({ table, u }); return { error: r.updateError ?? null } } }),
      }
      return chain
    },
  }
}

describe('resolveDisputeSource', () => {
  it('finds a sale and its location (race payments via the event)', async () => {
    const db = fakeDb({ race_payments: { data: [{ id: 'rp1', race: { location_id: 'locR' } }], error: null } })
    expect(await resolveDisputeSource(db, 'ord')).toMatchObject({ source_type: 'race_registration', source_id: 'rp1', location_id: 'locR' })
  })
  it('null when no table owns the order', async () => {
    expect(await resolveDisputeSource(fakeDb({}), 'ord')).toBeNull()
  })
  it('throws on a read error rather than reporting "not ours"', async () => {
    await expect(resolveDisputeSource(fakeDb({ cars: { data: null, error: new Error('x') } }), 'ord')).rejects.toThrow('x')
  })
})

describe('disputeRow', () => {
  it('maps the Revolut Dispute fields and strips the payer name', () => {
    const row = disputeRow({
      id: 'd', state: 'lost', reason_code: '50', reason_description: 'Fraud', amount: 1500, currency: 'EUR',
      response_due_date: '2026-11-05T12:00:00Z',
      payment: { order_id: 'o', payment_method: { type: 'sepa_direct_debit', debtor_name: 'Jane' } },
    }, null)
    expect(row).toMatchObject({ dispute_id: 'd', order_id: 'o', state: 'lost', reason: 'Fraud', amount_cents: 1500, currency: 'EUR', due_at: '2026-11-05T12:00:00Z', source_type: null, location_id: null })
    expect(row.raw.payment.payment_method.debtor_name).toBeUndefined()
  })
})

describe('noteDisputeOnOrder', () => {
  it('merges the dispute into orders.metadata and leaves status alone', async () => {
    const db = fakeDb({ orders: { data: [{ id: 'ord1', metadata: { utm: 'x' } }], error: null } })
    expect(await noteDisputeOnOrder(db, 'o', { dispute_id: 'd', state: 'needs_response' })).toBe(true)
    const u = db.updates[0].u
    expect(Object.keys(u)).toEqual(['metadata'])
    expect(u.metadata.utm).toBe('x')
    expect(u.metadata.revolut_dispute.dispute_id).toBe('d')
  })
  it('false when there is no ledger row', async () => {
    expect(await noteDisputeOnOrder(fakeDb({}), 'o', { dispute_id: 'd' })).toBe(false)
  })
  it('throws when the write fails', async () => {
    const db = fakeDb({ orders: { data: [{ id: 'o1', metadata: null }], error: null, updateError: new Error('w') } })
    await expect(noteDisputeOnOrder(db, 'o', { dispute_id: 'd' })).rejects.toThrow('w')
  })
})

describe('alertStaffOfDispute', () => {
  const row = { dispute_id: 'd', order_id: 'o', location_id: 'loc', amount_cents: 1500, currency: 'EUR', reason: 'Fraud', due_at: '2026-11-05T12:00:00Z' }
  it('sends an ops alert with amount, reason, due date and sale', async () => {
    sendOpsAlert.mockClear()
    const db = fakeDb({ locations: { data: { organization_id: 'org', name: 'Stillorgan' }, error: null } })
    expect(await alertStaffOfDispute(db, 'DISPUTE_ACTION_REQUIRED', row, { label: 'paid trial', source_id: 't1' })).toEqual({ sent: true })
    const arg = sendOpsAlert.mock.calls[0][0]
    expect(arg.organizationId).toBe('org')
    expect(arg.subject).toContain('15.00 EUR')
    expect(arg.htmlBody).toContain('Fraud')
    expect(arg.htmlBody).toContain('paid trial')
    expect(arg.htmlBody).toContain('2026')
  })
  it('never throws when the alert itself fails', async () => {
    sendOpsAlert.mockRejectedValueOnce(new Error('down'))
    const db = fakeDb({ locations: { data: { organization_id: 'org' }, error: null } })
    expect(await alertStaffOfDispute(db, 'DISPUTE_LOST', row, null)).toMatchObject({ sent: false })
  })
  it('no studio, no alert', async () => {
    expect(await alertStaffOfDispute(fakeDb({}), 'DISPUTE_LOST', { ...row, location_id: null }, null)).toMatchObject({ sent: false, reason: 'no_location' })
  })
})
