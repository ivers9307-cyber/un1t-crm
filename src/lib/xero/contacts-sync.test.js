// XERO-API.1 PR 1 — contacts-sync.js unit coverage.
//
// Same shape as accounts-sync.test.js. Extra coverage for the
// pagination loop: we feed two pages back from xfetch (first
// 100, second <100) and assert both rounds got upserted in the
// same sync.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const captured = {
  upserts: [],
  deletes: [],
  updates: [],
}

const xfetchMock = vi.fn()

vi.mock('./client', async () => {
  const actual = await vi.importActual('./client')
  return {
    ...actual,
    withFreshToken: vi.fn(async () => ({
      conn: { id: 'c1', location_id: 'loc1' },
      xfetch: xfetchMock,
    })),
  }
})

function buildDbMock() {
  return {
    from: vi.fn((table) => ({
      upsert: vi.fn((rows, opts) => {
        captured.upserts.push({ table, rows, opts })
        return Promise.resolve({ error: null })
      }),
      delete: vi.fn(() => ({
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn(() => {
          captured.deletes.push({ table })
          return Promise.resolve({ error: null, count: 0 })
        }),
      })),
      update: vi.fn((patch) => ({
        eq: vi.fn(() => {
          captured.updates.push({ table, patch })
          return Promise.resolve({ error: null })
        }),
      })),
    })),
  }
}

const mockDb = buildDbMock()
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

let pullContacts
beforeEach(async () => {
  vi.resetModules()
  captured.upserts = []
  captured.deletes = []
  captured.updates = []
  xfetchMock.mockReset()
  ;({ pullContacts } = await import('./contacts-sync'))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('pullContacts', () => {
  it('throws if locationId is falsy', async () => {
    await expect(pullContacts(undefined)).rejects.toThrow(/locationId/)
  })

  it('paginates until a page < 100 comes back', async () => {
    // 100 contacts on page 1 → keep going. 5 on page 2 → stop.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      ContactID: `c${i}`,
      Name: `Supplier ${i}`,
      EmailAddress: i === 0 ? 'a@b.com' : null,
      IsSupplier: true,
      IsCustomer: false,
      ContactStatus: 'ACTIVE',
    }))
    const page2 = Array.from({ length: 5 }, (_, i) => ({
      ContactID: `c${100 + i}`,
      Name: `Supplier ${100 + i}`,
      IsSupplier: false,
      IsCustomer: true,
      ContactStatus: 'ARCHIVED',
    }))
    xfetchMock
      .mockResolvedValueOnce({ Contacts: page1 })
      .mockResolvedValueOnce({ Contacts: page2 })

    const r = await pullContacts('loc1')
    expect(r.syncedCount).toBe(105)
    expect(r.pages).toBe(2)
    // 2 xfetch calls, with page=1 and page=2.
    expect(xfetchMock).toHaveBeenCalledTimes(2)
    expect(xfetchMock.mock.calls[0][0]).toMatch(/page=1/)
    expect(xfetchMock.mock.calls[1][0]).toMatch(/page=2/)
  })

  it('maps Xero fields to snake_case + coerces booleans', async () => {
    xfetchMock.mockResolvedValueOnce({
      Contacts: [
        {
          ContactID: 'c1',
          Name: 'Acme Ltd',
          EmailAddress: 'ap@acme.com',
          IsSupplier: true,
          IsCustomer: false,
          ContactStatus: 'ACTIVE',
          DefaultCurrency: 'EUR',
          TaxNumber: 'IE1234567',
        },
      ],
    })
    await pullContacts('loc1')
    const u = captured.upserts.find((u) => u.table === 'xero_contacts')
    expect(u).toBeTruthy()
    expect(u.opts).toEqual({ onConflict: 'location_id,xero_contact_id' })
    expect(u.rows[0]).toMatchObject({
      location_id: 'loc1',
      xero_contact_id: 'c1',
      name: 'Acme Ltd',
      email: 'ap@acme.com',
      is_supplier: true,
      is_customer: false,
      status: 'ACTIVE',
      default_currency: 'EUR',
      tax_number: 'IE1234567',
    })
  })

  it('writes contacts_sync_error on transport failure', async () => {
    xfetchMock.mockRejectedValueOnce(new Error('boom'))
    await expect(pullContacts('loc1')).rejects.toThrow(/boom/)
    const errStamp = captured.updates.find(
      (u) => u.table === 'xero_connections' && u.patch.contacts_sync_error
    )
    expect(errStamp).toBeTruthy()
  })

  it('stamps contacts_last_synced_at + clears error on success', async () => {
    xfetchMock.mockResolvedValueOnce({ Contacts: [] })
    await pullContacts('loc1')
    const stamp = captured.updates.find(
      (u) => u.table === 'xero_connections' && u.patch.contacts_last_synced_at
    )
    expect(stamp).toBeTruthy()
    expect(stamp.patch.contacts_sync_error).toBeNull()
  })
})
