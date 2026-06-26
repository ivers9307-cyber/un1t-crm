// Tests for GET /api/consultations/me (champ-app member coach-feedback read).
//
// The privacy contract: returns ONLY member_feedback + when + coach name,
// never the staff-only `notes`. Customer-authed via resolveCustomerContact.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/customer-auth', () => ({ resolveCustomerContact: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'

function makeDb({ consultations = [], profiles = [] }) {
  return {
    from: vi.fn((table) => {
      if (table === 'consultations') {
        return {
          select: () => ({
            eq: () => ({
              not: () => ({
                order: () => Promise.resolve({ data: consultations, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'profiles') {
        return { select: () => ({ in: () => Promise.resolve({ data: profiles, error: null }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

const req = () => new Request('http://localhost/api/consultations/me', { headers: { authorization: 'Bearer t' } })

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/consultations/me', () => {
  it('returns only member-shareable fields (feedback + coach name), never notes', async () => {
    createServerClient.mockReturnValue(makeDb({
      consultations: [{ id: 'x1', consulted_at: '2026-06-12T12:00:00Z', member_feedback: 'Great month', coach_id: 'p1' }],
      profiles: [{ id: 'p1', full_name: 'Jordan M.' }],
    }))
    resolveCustomerContact.mockResolvedValue({ contact: { id: 'c1', location_id: 'l1' } })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toEqual([
      { id: 'x1', consulted_at: '2026-06-12T12:00:00Z', member_feedback: 'Great month', coach_name: 'Jordan M.' },
    ])
    expect(json.data[0]).not.toHaveProperty('notes')
  })

  it('returns 401 when the member token is invalid', async () => {
    createServerClient.mockReturnValue(makeDb({}))
    resolveCustomerContact.mockResolvedValue({ error: 'unauthorised' })
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('returns 409 when the token has no linked contact', async () => {
    createServerClient.mockReturnValue(makeDb({}))
    resolveCustomerContact.mockResolvedValue({ error: 'no_contact' })
    const res = await GET(req())
    expect(res.status).toBe(409)
  })
})
