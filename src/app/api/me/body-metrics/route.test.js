// Tests for POST /api/me/body-metrics (champ-app member self-service body metrics).
//
// Security contract: only the caller's own contact is ever written.
// Completion contract: profile_setup_completed_at is stamped only when
//   dob + gender + weight_kg are all present for the first time.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/customer-auth', () => ({ resolveCustomerContact: vi.fn() }))
vi.mock('@/lib/body-metrics', () => ({ applyWeightObservation: vi.fn(async () => true) }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'
import { applyWeightObservation } from '@/lib/body-metrics'

// Minimal chained Supabase mock. Records updates and returns configurable row
// from the final .maybeSingle() (the re-read after writes).
function makeDb({ row = null, updateError = null } = {}) {
  const updates = []
  return {
    _updates: updates,
    from: vi.fn((table) => {
      const builder = {
        update: vi.fn((patch) => {
          updates.push({ table, patch })
          return { eq: vi.fn(() => Promise.resolve({ error: updateError })) }
        }),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: row, error: null })),
          })),
        })),
      }
      return builder
    }),
  }
}

function req(body = {}) {
  return {
    headers: { get: (h) => (h === 'authorization' ? 'Bearer tok' : null) },
    json: async () => body,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveCustomerContact.mockResolvedValue({ contact: { id: 'c-1', location_id: 'loc-1' } })
})

describe('POST /api/me/body-metrics', () => {
  it('returns 401 when resolveCustomerContact yields an error', async () => {
    resolveCustomerContact.mockResolvedValue({ error: 'unauthorised' })
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(req({ gender: 'female' }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('returns 400 when body fails schema validation (weight out of range)', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(req({ weight_kg: 5 })) // below min(20)
    expect(res.status).toBe(400)
  })

  it('saves gender and dob on the contacts row', async () => {
    const row = { dob: '1990-05-20', gender: 'female', weight_kg: null, profile_setup_completed_at: null }
    const db = makeDb({ row })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ gender: 'female', dob: '1990-05-20' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.gender).toBe('female')
    expect(json.data.dob).toBe('1990-05-20')
    // One contacts update for the patch
    const contactUpdates = db._updates.filter((u) => u.table === 'contacts')
    expect(contactUpdates.length).toBeGreaterThanOrEqual(1)
    expect(contactUpdates[0].patch).toMatchObject({ gender: 'female', dob: '1990-05-20' })
  })

  it('calls applyWeightObservation when weight_kg is provided', async () => {
    const row = { dob: null, gender: null, weight_kg: 75, profile_setup_completed_at: null }
    createServerClient.mockReturnValue(makeDb({ row }))

    await POST(req({ weight_kg: 75 }))
    expect(applyWeightObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: 'c-1', weightKg: 75, source: 'manual' }),
    )
  })

  it('stamps profile_setup_completed_at when dob + gender + weight_kg all present and not yet stamped', async () => {
    // Row returned after writes has all three set, no stamp yet
    const row = { dob: '1990-05-20', gender: 'male', weight_kg: 82, profile_setup_completed_at: null }
    const db = makeDb({ row })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ dob: '1990-05-20', gender: 'male', weight_kg: 82 }))
    expect(res.status).toBe(200)
    const json = await res.json()
    // The stamp is injected into the returned data
    expect(json.data.profile_setup_completed_at).not.toBeNull()
    // And the update was issued on contacts
    const stampUpdates = db._updates.filter(
      (u) => u.table === 'contacts' && u.patch.profile_setup_completed_at,
    )
    expect(stampUpdates).toHaveLength(1)
  })

  it('does NOT re-stamp profile_setup_completed_at when already set', async () => {
    const already = '2026-01-01T00:00:00.000Z'
    const row = { dob: '1990-05-20', gender: 'female', weight_kg: 60, profile_setup_completed_at: already }
    const db = makeDb({ row })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ weight_kg: 61 }))
    expect(res.status).toBe(200)
    const stampUpdates = db._updates.filter(
      (u) => u.table === 'contacts' && u.patch.profile_setup_completed_at,
    )
    expect(stampUpdates).toHaveLength(0)
    const json = await res.json()
    expect(json.data.profile_setup_completed_at).toBe(already)
  })

  it('does NOT stamp when any of dob/gender/weight_kg is missing', async () => {
    // weight_kg is null — should not stamp
    const row = { dob: '1990-05-20', gender: 'female', weight_kg: null, profile_setup_completed_at: null }
    const db = makeDb({ row })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ dob: '1990-05-20', gender: 'female' }))
    expect(res.status).toBe(200)
    const stampUpdates = db._updates.filter(
      (u) => u.table === 'contacts' && u.patch.profile_setup_completed_at,
    )
    expect(stampUpdates).toHaveLength(0)
    const json = await res.json()
    expect(json.data.profile_setup_completed_at).toBeNull()
  })
})
