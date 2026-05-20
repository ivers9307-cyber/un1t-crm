// XERO-API.1 PR 1 — accounts-sync.js unit coverage.
//
// We're locking three things:
//   1. The Xero /Accounts response → DB row mapping (field names
//      flip from PascalCase to snake_case; ShowInExpenseClaims
//      gets boolean-coerced).
//   2. The stale-row sweep — accounts not returned by Xero this
//      round get DELETEd (matched by last_synced_at < syncStartedAt).
//   3. The success-path stamps accounts_last_synced_at +
//      clears accounts_sync_error on xero_connections.
//
// We stub `withFreshToken` to return a fixed `xfetch` and stub
// `createServerClient` to return a chainable mock that captures
// the upsert / delete / update calls so we can assert the shape
// of each.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Captured by the mocks so individual tests can assert on what
// was passed to .upsert() / .delete() / .update().
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

// Chainable mock that mimics supabase-js: from(...).upsert(...)
// resolves to {error:null}; from(...).delete(...).eq().lt()
// resolves to {error:null, count: N}; from(...).update(...).eq()
// resolves to {error:null}.
function buildDbMock() {
  return {
    from: vi.fn((table) => {
      const chain = {
        upsert: vi.fn((rows, opts) => {
          captured.upserts.push({ table, rows, opts })
          return Promise.resolve({ error: null })
        }),
        delete: vi.fn(() => {
          // delete() returns a chainable that .eq + .lt off of.
          const delChain = {
            eq: vi.fn().mockReturnThis(),
            lt: vi.fn(() => {
              captured.deletes.push({ table })
              return Promise.resolve({ error: null, count: 2 })
            }),
          }
          return delChain
        }),
        update: vi.fn((patch) => {
          const updChain = {
            eq: vi.fn(() => {
              captured.updates.push({ table, patch })
              return Promise.resolve({ error: null })
            }),
          }
          return updChain
        }),
      }
      return chain
    }),
  }
}

const mockDb = buildDbMock()
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

let pullAccounts
beforeEach(async () => {
  vi.resetModules()
  captured.upserts = []
  captured.deletes = []
  captured.updates = []
  xfetchMock.mockReset()
  ;({ pullAccounts } = await import('./accounts-sync'))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('pullAccounts', () => {
  it('throws if locationId is falsy', async () => {
    await expect(pullAccounts(null)).rejects.toThrow(/locationId/)
  })

  it('maps Xero /Accounts response into snake_case rows + tags last_synced_at', async () => {
    xfetchMock.mockResolvedValueOnce({
      Accounts: [
        {
          AccountID: 'a1',
          Code: '400',
          Name: 'Sales',
          Type: 'REVENUE',
          Status: 'ACTIVE',
          TaxType: 'OUTPUT2',
          ShowInExpenseClaims: false,
        },
        {
          AccountID: 'a2',
          Code: '500',
          Name: 'Office expenses',
          Type: 'EXPENSE',
          Status: 'ACTIVE',
          TaxType: 'INPUT2',
          // String "true" — Xero returns boolean strings on some
          // org states.
          ShowInExpenseClaims: 'true',
        },
      ],
    })
    const r = await pullAccounts('loc1')
    expect(r.syncedCount).toBe(2)
    expect(r.deletedCount).toBe(2) // mock returns 2

    // First captured upsert is the one we care about.
    const upsert = captured.upserts.find((u) => u.table === 'xero_accounts')
    expect(upsert).toBeTruthy()
    expect(upsert.opts).toEqual({ onConflict: 'location_id,xero_account_id' })
    expect(upsert.rows).toHaveLength(2)
    expect(upsert.rows[0]).toMatchObject({
      location_id: 'loc1',
      xero_account_id: 'a1',
      code: '400',
      name: 'Sales',
      account_type: 'REVENUE',
      status: 'ACTIVE',
      tax_type: 'OUTPUT2',
      show_in_expense_claims: false,
    })
    // String "true" coerced to boolean true.
    expect(upsert.rows[1].show_in_expense_claims).toBe(true)
    // Every row stamped with the same syncStartedAt.
    expect(upsert.rows[0].last_synced_at).toBe(upsert.rows[1].last_synced_at)
  })

  it('still runs the stale-row delete + connection stamp even when Xero returns zero accounts', async () => {
    xfetchMock.mockResolvedValueOnce({ Accounts: [] })
    const r = await pullAccounts('loc1')
    expect(r.syncedCount).toBe(0)
    // No upsert (we skip the call when 0 rows).
    expect(captured.upserts.find((u) => u.table === 'xero_accounts')).toBeFalsy()
    // But the delete sweep DID run.
    expect(captured.deletes.find((d) => d.table === 'xero_accounts')).toBeTruthy()
    // And the connection got its success stamp.
    const stamp = captured.updates.find(
      (u) => u.table === 'xero_connections' && u.patch.accounts_last_synced_at
    )
    expect(stamp).toBeTruthy()
    expect(stamp.patch.accounts_sync_error).toBeNull()
  })

  it('writes the error onto xero_connections.accounts_sync_error when Xero call fails', async () => {
    xfetchMock.mockRejectedValueOnce(Object.assign(new Error('Xero 401'), { status: 401 }))
    await expect(pullAccounts('loc1')).rejects.toThrow(/Xero 401/)
    const errStamp = captured.updates.find(
      (u) => u.table === 'xero_connections' && u.patch.accounts_sync_error
    )
    expect(errStamp).toBeTruthy()
    expect(errStamp.patch.accounts_sync_error).toContain('Xero 401')
  })

  it('handles non-array Xero response defensively', async () => {
    xfetchMock.mockResolvedValueOnce({}) // no Accounts key
    const r = await pullAccounts('loc1')
    expect(r.syncedCount).toBe(0)
  })
})
