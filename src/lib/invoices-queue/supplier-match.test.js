// SUPPLIERMATCH.1 — the three rules that recognise a supplier, on the shared
// fake database. Each rule answers only on exactly one contact.
import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
import { matchSupplier, tidySupplierName } from './supplier-defaults'

const LOC = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const contact = (id, name, over = {}) => ({ location_id: LOC, xero_contact_id: id, name, email: null, status: 'ACTIVE', is_supplier: true, ...over })
const sent = (supplier_name, contactId, over = {}) => ({
  id: `q-${Math.random().toString(36).slice(2)}`,
  location_id: LOC,
  status: 'forwarded',
  received_at: '2026-10-01T10:00:00.000Z',
  extracted_fields: { supplier_name, xero_contact_ref: { kind: 'existing', xero_contact_id: contactId, name: 'x' } },
  ...over,
})
const make = (contacts = [], queue = []) => createFakeDb({ tables: { xero_contacts: contacts, invoices_queue: queue } })

describe('tidySupplierName', () => {
  it.each([
    ['Acme Supplies Ltd.', 'acme supplies'],
    ['ACME SUPPLIES LIMITED', 'acme supplies'],
    ['Acme Supplies, S.L.', 'acme supplies'],
    ['Acme Supplies B.V. (Head Office)', 'acme supplies'],
    ['Acme Supplies Ltd t/a Acme Print', 'acme supplies'],
    ['Acme Holdings c/o Agent & Co', 'acme holdings'],
    ['The Acme Company', 'acme'],
    ['Café Ácme GmbH', 'cafe acme'],
    ['Smith & Jones', 'smith and jones'],
    ['Acme   Supplies', 'acme supplies'],
  ])('%s → %s', (raw, key) => expect(tidySupplierName(raw)).toBe(key))

  it('never tidies a name away to nothing but its legal form', () => {
    expect(tidySupplierName('Limited')).toBe('limited')
    expect(tidySupplierName('The')).toBe('the')
  })

  it('gives nothing for a blank or one-letter name', () => {
    expect(tidySupplierName('')).toBe('')
    expect(tidySupplierName(null)).toBe('')
    expect(tidySupplierName('(X)')).toBe('')
  })

  it('keeps different suppliers apart', () => {
    expect(tidySupplierName('Acme Supplies')).not.toBe(tidySupplierName('Acme Supply'))
    expect(tidySupplierName('Acme Print')).not.toBe(tidySupplierName('Acme Printing'))
  })
})

describe('matchSupplier — rule 1, the exact name', () => {
  it('matches whatever the case', async () => {
    const db = make([contact('c1', 'Acme Supplies')])
    expect(await matchSupplier(db, LOC, 'ACME SUPPLIES')).toMatchObject({ xero_contact_id: 'c1' })
  })
})

describe('matchSupplier — rule 3, the tidied name', () => {
  it('matches a name that differs only in its legal form', async () => {
    const db = make([contact('c1', 'Acme Supplies')])
    expect(await matchSupplier(db, LOC, 'Acme Supplies Ltd.')).toMatchObject({ xero_contact_id: 'c1' })
  })

  it('answers nothing when two suppliers tidy to the same name', async () => {
    const db = make([contact('c1', 'Acme Supplies Ltd'), contact('c2', 'Acme Supplies (Ireland)')])
    expect(await matchSupplier(db, LOC, 'Acme Supplies Limited')).toBeNull()
  })

  it('never matches part of a name', async () => {
    const db = make([contact('c1', 'Acme'), contact('c2', 'Acme Supplies Group')])
    expect(await matchSupplier(db, LOC, 'Acme Supplies Ltd')).toBeNull()
  })

  it('ignores archived contacts, customers and other studios', async () => {
    const db = make([
      contact('c1', 'Acme Supplies', { status: 'ARCHIVED' }),
      contact('c2', 'Acme Supplies', { is_supplier: false }),
      contact('c3', 'Acme Supplies', { location_id: OTHER }),
    ])
    expect(await matchSupplier(db, LOC, 'Acme Supplies Ltd')).toBeNull()
  })
})

describe('matchSupplier — rule 2, what this studio sent before', () => {
  it('matches a name Xero spells differently, from an earlier sent bill', async () => {
    const db = make([contact('c9', 'acme')], [sent('Acme Supplies International Ltd', 'c9')])
    expect(await matchSupplier(db, LOC, 'ACME SUPPLIES INTERNATIONAL LIMITED')).toMatchObject({ xero_contact_id: 'c9', name: 'acme' })
  })

  it('counts an approved bill as well as a sent one', async () => {
    const db = make([contact('c9', 'acme')], [sent('Acme Supplies International', 'c9', { status: 'data_approved' })])
    expect(await matchSupplier(db, LOC, 'Acme Supplies International')).toMatchObject({ xero_contact_id: 'c9' })
  })

  it('answers nothing when earlier bills under the name went to two contacts', async () => {
    const db = make([contact('c8', 'acme a'), contact('c9', 'acme b')], [sent('Acme Intl', 'c8'), sent('Acme Intl', 'c9')])
    expect(await matchSupplier(db, LOC, 'Acme Intl')).toBeNull()
  })

  it('ignores rows that were only read, rejected rows and other studios', async () => {
    const db = make([contact('c9', 'acme')], [
      sent('Acme Intl', 'c9', { status: 'extracted' }),
      sent('Acme Intl', 'c9', { status: 'rejected' }),
      sent('Acme Intl', 'c9', { location_id: OTHER }),
    ])
    expect(await matchSupplier(db, LOC, 'Acme Intl')).toBeNull()
  })

  it('answers nothing when the contact is archived or gone from Xero', async () => {
    const archived = make([contact('c9', 'acme', { status: 'ARCHIVED' })], [sent('Acme Intl', 'c9')])
    expect(await matchSupplier(archived, LOC, 'Acme Intl')).toBeNull()
    const gone = make([], [sent('Acme Intl', 'c9')])
    expect(await matchSupplier(gone, LOC, 'Acme Intl')).toBeNull()
  })

  it('wins over a tidied-name match, because a person chose it', async () => {
    const db = make([contact('c1', 'Acme Intl'), contact('c9', 'acme euro account')], [sent('Acme Intl Ltd', 'c9')])
    expect(await matchSupplier(db, LOC, 'Acme Intl Ltd')).toMatchObject({ xero_contact_id: 'c9' })
  })
})

describe('matchSupplier — failure', () => {
  it('a failed history read falls through to no match, never a throw', async () => {
    const db = createFakeDb({ tables: { xero_contacts: [], invoices_queue: [] }, errors: { invoices_queue: { select: { message: 'boom' } } } })
    expect(await matchSupplier(db, LOC, 'Acme Supplies Ltd')).toBeNull()
  })
})
