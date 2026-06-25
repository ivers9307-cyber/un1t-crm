// Route-level tests for GET /api/contacts/[id]/consent-log.
//
// SECURITY REGRESSION GUARD (H1, 2026-06 platform audit). The route runs
// as service-role (RLS bypassed), so before this fix ANY authenticated
// caller could read ANY contact's GDPR consent history — including
// ip_address and performed_by — just by enumerating contact IDs. These
// tests pin the application-layer gate: resolve the contact's location,
// then assertLocationAccess(). Cross-location callers get 404; a missing
// contact gets 404.
//
// We use the REAL assertLocationAccess — only getCurrentUser + the
// Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'loc-a'
const LOC_B = 'loc-b'

// ─── DB mock ─────────────────────────────────────────────────────
//
// GET reads:
//   1. from('contacts').select('location_id').eq('id', x).maybeSingle()
//   2. from('consent_log').select(...).eq('contact_id', x).order(...).limit(N)
function mockDb({ contact, contactError = null, rows = [], rowsError = null } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        const maybeSingle = vi.fn(() =>
          Promise.resolve(contactError ? { data: null, error: contactError } : { data: contact, error: null })
        )
        const eq = vi.fn(() => ({ maybeSingle }))
        const select = vi.fn(() => ({ eq }))
        return { select }
      }
      if (table === 'consent_log') {
        const limit = vi.fn(() =>
          Promise.resolve(rowsError ? { data: null, error: rowsError } : { data: rows, error: null })
        )
        const order = vi.fn(() => ({ limit }))
        const eq = vi.fn(() => ({ order }))
        const select = vi.fn(() => ({ eq }))
        return { select }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

const userAtA = {
  id: 'u1', isMaster: false, role: 'manager',
  locations: [{ id: LOC_A, name: 'A' }],
}

beforeEach(() => {
  vi.clearAllMocks()
})

const FAKE_REQUEST = new Request('https://example.com/api/contacts/c1/consent-log')

describe('GET /api/contacts/[id]/consent-log', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the contact does not exist', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({ contact: null }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the contact is in a location the caller is not assigned to (IDOR)', async () => {
    getCurrentUser.mockResolvedValue(userAtA) // assigned to LOC_A only
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_B },                 // contact lives at LOC_B
      rows: [{ id: 'cl1', ip_address: '1.2.3.4' }],    // would leak if not gated
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
    // The consent rows (with ip_address) must NOT be in the response.
    expect(body.rows).toBeUndefined()
  })

  it('returns the consent history when the contact is in the caller’s location', async () => {
    getCurrentUser.mockResolvedValue(userAtA)
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_A },
      rows: [
        { id: 'cl1', created_at: '2026-05-01T00:00:00Z', channel: 'email', action: 'opt_in', source: 'form', ip_address: '1.2.3.4', performed_by: null, profiles: null },
      ],
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].ip_address).toBe('1.2.3.4')
  })

  it('lets a master read consent history for any location', async () => {
    // getCurrentUser loads every active location into user.locations for
    // masters, so assertLocationAccess passes naturally.
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master',
      locations: [{ id: LOC_A }, { id: LOC_B }],
    })
    createServerClient.mockReturnValue(mockDb({
      contact: { location_id: LOC_B },
      rows: [{ id: 'cl1', ip_address: '9.9.9.9', profiles: null }],
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })
})
