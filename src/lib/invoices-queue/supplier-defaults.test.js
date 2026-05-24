// SUPPLIER-MEMORY.1 — supplier-defaults helper coverage.
//
// The helpers take `db` as a parameter (no createServerClient
// import), so the tests pass a hand-built chainable in place of the
// supabase-js query builder. Each filter method returns the chain;
// a terminal (.limit / .maybeSingle / .upsert) resolves. We lock the
// match-confidence rule (exactly one row), the extraction-patch
// shape, and the use_count increment — the bits route code relies on.

import { describe, it, expect, vi } from 'vitest'
import {
  matchSupplier,
  getSupplierDefault,
  recordSupplierDefault,
  resolveExtractionDefaults,
} from './supplier-defaults'

function contactsChain(result) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    limit: () => Promise.resolve(result),
  }
  return chain
}

function defaultsChain(result, upsertSpy) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(result),
    upsert: upsertSpy || (() => Promise.resolve({ data: null, error: null })),
  }
  return chain
}

function makeDb({ contacts, defaultRow, upsertSpy } = {}) {
  return {
    from(table) {
      if (table === 'xero_contacts') {
        return contactsChain({ data: contacts ?? [], error: null })
      }
      if (table === 'xero_supplier_defaults') {
        return defaultsChain({ data: defaultRow ?? null, error: null }, upsertSpy)
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

describe('matchSupplier', () => {
  it('returns null for a too-short name (no query)', async () => {
    const db = makeDb({ contacts: [{ xero_contact_id: 'c1', name: 'A', email: null }] })
    expect(await matchSupplier(db, 'loc1', 'A')).toBeNull()
  })

  it('returns null when no contact matches', async () => {
    const db = makeDb({ contacts: [] })
    expect(await matchSupplier(db, 'loc1', 'Acme Ltd')).toBeNull()
  })

  it('returns null when the match is ambiguous (2+ rows)', async () => {
    const db = makeDb({
      contacts: [
        { xero_contact_id: 'c1', name: 'Acme', email: null },
        { xero_contact_id: 'c2', name: 'Acme', email: null },
      ],
    })
    expect(await matchSupplier(db, 'loc1', 'Acme')).toBeNull()
  })

  it('returns the contact on an unambiguous single match', async () => {
    const db = makeDb({ contacts: [{ xero_contact_id: 'c1', name: 'Acme Ltd', email: 'ap@acme.ie' }] })
    expect(await matchSupplier(db, 'loc1', 'Acme Ltd')).toEqual({
      xero_contact_id: 'c1', name: 'Acme Ltd', email: 'ap@acme.ie',
    })
  })
})

describe('resolveExtractionDefaults', () => {
  it('returns an empty patch when no supplier matches', async () => {
    const db = makeDb({ contacts: [] })
    expect(await resolveExtractionDefaults(db, 'loc1', 'Unknown Co')).toEqual({})
  })

  it('returns just the supplier ref when matched but no stored default', async () => {
    const db = makeDb({
      contacts: [{ xero_contact_id: 'c1', name: 'Acme Ltd', email: null }],
      defaultRow: null,
    })
    const patch = await resolveExtractionDefaults(db, 'loc1', 'Acme Ltd')
    expect(patch.xero_contact_ref).toEqual({ kind: 'existing', xero_contact_id: 'c1', name: 'Acme Ltd' })
    expect(patch.xero_account_id).toBeUndefined()
    expect(patch.category).toBeUndefined()
  })

  it('includes the remembered account + category when a default exists', async () => {
    const db = makeDb({
      contacts: [{ xero_contact_id: 'c1', name: 'Acme Ltd', email: 'ap@acme.ie' }],
      defaultRow: {
        default_account_code: '420',
        default_xero_account_id: 'acc-guid-1',
        default_category: 'utilities',
      },
    })
    const patch = await resolveExtractionDefaults(db, 'loc1', 'Acme Ltd')
    expect(patch.xero_contact_ref).toEqual({
      kind: 'existing', xero_contact_id: 'c1', name: 'Acme Ltd', email: 'ap@acme.ie',
    })
    expect(patch.xero_account_id).toBe('acc-guid-1')
    expect(patch.account_code).toBe('420')
    expect(patch.category).toBe('utilities')
  })
})

describe('getSupplierDefault', () => {
  it('returns null when nothing is stored', async () => {
    const db = makeDb({ defaultRow: null })
    expect(await getSupplierDefault(db, 'loc1', 'c1')).toBeNull()
  })

  it('returns the stored row', async () => {
    const db = makeDb({ defaultRow: { default_xero_account_id: 'acc-1', default_category: 'rent' } })
    expect(await getSupplierDefault(db, 'loc1', 'c1')).toEqual({
      default_xero_account_id: 'acc-1', default_category: 'rent',
    })
  })
})

describe('recordSupplierDefault', () => {
  it('no-ops without an xero_account_id', async () => {
    const upsert = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const db = makeDb({ upsertSpy: upsert })
    await recordSupplierDefault(db, { locationId: 'loc1', xeroContactId: 'c1' })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('upserts and increments use_count from the existing row', async () => {
    const upsert = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const db = makeDb({ defaultRow: { use_count: 3 }, upsertSpy: upsert })
    await recordSupplierDefault(db, {
      locationId: 'loc1', xeroContactId: 'c1', supplierName: 'Acme Ltd',
      accountCode: '420', xeroAccountId: 'acc-1', category: 'utilities',
    })
    expect(upsert).toHaveBeenCalledTimes(1)
    const [payload, opts] = upsert.mock.calls[0]
    expect(payload.use_count).toBe(4)
    expect(payload.default_xero_account_id).toBe('acc-1')
    expect(payload.default_account_code).toBe('420')
    expect(payload.default_category).toBe('utilities')
    expect(opts).toEqual({ onConflict: 'location_id,xero_contact_id' })
  })

  it('starts use_count at 1 when there is no existing row', async () => {
    const upsert = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const db = makeDb({ defaultRow: null, upsertSpy: upsert })
    await recordSupplierDefault(db, {
      locationId: 'loc1', xeroContactId: 'c1', accountCode: '400', xeroAccountId: 'acc-9',
    })
    expect(upsert.mock.calls[0][0].use_count).toBe(1)
  })
})
