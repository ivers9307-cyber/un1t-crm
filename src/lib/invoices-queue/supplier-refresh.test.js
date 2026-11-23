// SUPPLIERMATCH.1 — the sweeper's two supplier jobs, on the shared fake database.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/xero/contacts-sync', () => ({ pullContacts: vi.fn(async () => { throw new Error('no real Xero in tests') }) }))
vi.mock('@/lib/xero/client', () => ({ withFreshToken: vi.fn(async () => { throw new Error('no real Xero in tests') }) }))

import { refreshStaleSupplierList, rematchUnmatchedSuppliers, REMATCH_LIMIT } from './supplier-refresh'
import { logWarn } from '@/lib/log'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-11-23T12:00:00.000Z')
const now = () => NOW
const conn = (location_id, contacts_last_synced_at) => ({ id: `conn-${location_id[0]}`, location_id, contacts_last_synced_at })

describe('refreshStaleSupplierList', () => {
  let pull
  beforeEach(() => { vi.clearAllMocks(); pull = vi.fn(async () => ({ syncedCount: 3 })) })

  it('pulls a studio whose list is over a day old and moves its stamp', async () => {
    const db = createFakeDb({ tables: { xero_connections: [conn(A, '2026-11-20T12:00:00.000Z')] } })
    expect(await refreshStaleSupplierList(db, { now, pull })).toEqual({ refreshed: A })
    expect(pull).toHaveBeenCalledWith(A)
    expect(db.tables.xero_connections[0].contacts_last_synced_at).toBe(NOW.toISOString())
  })

  it('leaves a list refreshed within the day alone', async () => {
    const db = createFakeDb({ tables: { xero_connections: [conn(A, '2026-11-23T01:00:00.000Z')] } })
    expect(await refreshStaleSupplierList(db, { now, pull })).toEqual({ refreshed: null })
    expect(pull).not.toHaveBeenCalled()
  })

  it('takes one studio a call: the never-synced one first, then the oldest', async () => {
    const db = createFakeDb({ tables: { xero_connections: [conn(A, '2026-11-01T12:00:00.000Z'), conn(B, null)] } })
    expect(await refreshStaleSupplierList(db, { now, pull })).toEqual({ refreshed: B })
    expect(await refreshStaleSupplierList(db, { now, pull })).toEqual({ refreshed: A })
    expect(await refreshStaleSupplierList(db, { now, pull })).toEqual({ refreshed: null })
    expect(pull).toHaveBeenCalledTimes(2)
  })

  it('does not pull when another tick moved the stamp first', async () => {
    const db = createFakeDb({ tables: { xero_connections: [conn(A, '2026-11-20T12:00:00.000Z')] } })
    const racing = vi.fn(async () => ({}))
    const realFrom = db.from.bind(db)
    let reads = 0
    db.from = (table) => {
      const builder = realFrom(table)
      // After this call's read, another tick claims the studio.
      if (table === 'xero_connections' && ++reads === 2) db.tables.xero_connections[0].contacts_last_synced_at = '2026-11-23T11:59:59.000Z'
      return builder
    }
    expect(await refreshStaleSupplierList(db, { now, pull: racing })).toEqual({ refreshed: null })
    expect(racing).not.toHaveBeenCalled()
  })

  it('a failed pull is logged, keeps the stamp and never throws', async () => {
    const db = createFakeDb({ tables: { xero_connections: [conn(A, null)] } })
    pull.mockRejectedValueOnce(new Error('token expired'))
    expect(await refreshStaleSupplierList(db, { now, pull })).toEqual({ refreshed: null })
    expect(db.tables.xero_connections[0].contacts_last_synced_at).toBe(NOW.toISOString())
    expect(logWarn).toHaveBeenCalled()
  })

  it('a failed read of the connections never throws', async () => {
    const db = createFakeDb({ tables: { xero_connections: [] }, errors: { xero_connections: { select: { message: 'boom' } } } })
    expect(await refreshStaleSupplierList(db, { now, pull })).toEqual({ refreshed: null })
  })
})

describe('rematchUnmatchedSuppliers', () => {
  const SYNCED = '2026-11-23T09:00:00.000Z'
  const contact = { location_id: A, xero_contact_id: 'c1', name: 'Acme Supplies', email: null, status: 'ACTIVE', is_supplier: true }
  const row = (id, over = {}) => ({
    id, location_id: A, status: 'extracted', received_at: '2026-11-22T10:00:00.000Z',
    prepared_at: '2026-11-22T10:01:00.000Z', review_reasons: ['new_supplier'],
    extracted_fields: { supplier_name: 'Acme Supplies Ltd.', invoice_number: id, invoice_date: '2026-11-01', subtotal: 100, tax_amount: 0, total: 100, document_type: 'invoice' },
    ...over,
  })
  const make = (rows, { connections = [conn(A, SYNCED)], contacts = [contact] } = {}) =>
    createFakeDb({ tables: { xero_connections: connections, xero_contacts: contacts, invoices_queue: rows, xero_tax_rates: [], xero_supplier_defaults: [] } })
  const get = (db, id) => db.tables.invoices_queue.find((r) => r.id === id)

  it('matches a row checked before the contact list was refreshed', async () => {
    const db = make([row('q1')])
    expect(await rematchUnmatchedSuppliers(db)).toEqual({ checked: 1, matched: 1 })
    expect(get(db, 'q1').extracted_fields.xero_contact_ref.xero_contact_id).toBe('c1')
    expect(get(db, 'q1').review_reasons).not.toContain('new_supplier')
  })

  it('looks at a row once per change: a second pass finds nothing to do', async () => {
    const db = make([row('q1', { extracted_fields: { ...row('q1').extracted_fields, supplier_name: 'Nobody Known' } })])
    expect(await rematchUnmatchedSuppliers(db)).toEqual({ checked: 1, matched: 0 })
    expect(await rematchUnmatchedSuppliers(db)).toEqual({ checked: 0, matched: 0 })
  })

  it('a bill the studio sent since the row was checked triggers a look, and teaches the name', async () => {
    const sent = row('q0', {
      status: 'forwarded', forwarded_at: '2026-11-23T11:00:00.000Z', review_reasons: [],
      extracted_fields: { supplier_name: 'Acme Intl', xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1', name: 'Acme Supplies' } },
    })
    const waiting = row('q1', { prepared_at: '2026-11-23T10:00:00.000Z', extracted_fields: { ...row('q1').extracted_fields, supplier_name: 'ACME INTL LTD' } })
    const db = make([sent, waiting])
    expect(await rematchUnmatchedSuppliers(db)).toEqual({ checked: 1, matched: 1 })
    expect(get(db, 'q1').extracted_fields.xero_contact_ref.xero_contact_id).toBe('c1')
  })

  it('leaves alone rows checked after the last change, rows with no new-supplier flag, rows never prepared and other statuses', async () => {
    const db = make([
      row('fresh', { prepared_at: '2026-11-23T09:30:00.000Z' }),
      row('known', { review_reasons: ['no_vat_rate'] }),
      row('legacy', { prepared_at: null }),
      row('approved', { status: 'data_approved' }),
    ])
    expect(await rematchUnmatchedSuppliers(db)).toEqual({ checked: 0, matched: 0 })
    for (const id of ['fresh', 'known', 'legacy', 'approved']) expect(get(db, id).extracted_fields.xero_contact_ref).toBeUndefined()
  })

  it('does nothing for a studio with no Xero connection', async () => {
    const db = make([row('q1')], { connections: [] })
    expect(await rematchUnmatchedSuppliers(db)).toEqual({ checked: 0, matched: 0 })
  })

  it('stops at the limit and carries on next time', async () => {
    const db = make(Array.from({ length: REMATCH_LIMIT + 3 }, (_, i) => row(`q${i}`)))
    expect((await rematchUnmatchedSuppliers(db)).checked).toBe(REMATCH_LIMIT)
    expect((await rematchUnmatchedSuppliers(db)).checked).toBe(3)
  })

  it('a failed read never throws', async () => {
    const db = createFakeDb({ tables: { xero_connections: [] }, errors: { xero_connections: { select: { message: 'boom' } } } })
    expect(await rematchUnmatchedSuppliers(db)).toEqual({ checked: 0, matched: 0 })
  })
})
