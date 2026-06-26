// Tests for GET /api/consultation-photos/me (champ-app member photo read).
//
// Returns the member's own consultation_photos with server-minted signed URLs
// (the bucket is private). Customer-authed via resolveCustomerContact.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/customer-auth', () => ({ resolveCustomerContact: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'

function makeDb({ photos = [], signed = [] }) {
  return {
    from: vi.fn((table) => {
      if (table === 'consultation_photos') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: photos, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
    storage: {
      from: vi.fn(() => ({
        createSignedUrls: vi.fn(() => Promise.resolve({ data: signed, error: null })),
      })),
    },
  }
}

const req = () => new Request('http://localhost/api/consultation-photos/me', { headers: { authorization: 'Bearer t' } })

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/consultation-photos/me', () => {
  it('returns the member photos with signed URLs + the source discriminator', async () => {
    createServerClient.mockReturnValue(makeDb({
      photos: [{ id: 'p1', storage_path: 'consultations/c1/x.jpg', taken_at: '2026-06-12T00:00:00Z', label: 'Front', caption: null, source: 'member' }],
      signed: [{ path: 'consultations/c1/x.jpg', signedUrl: 'https://signed/x' }],
    }))
    resolveCustomerContact.mockResolvedValue({ contact: { id: 'c1', location_id: 'l1' } })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toEqual([
      { id: 'p1', taken_at: '2026-06-12T00:00:00Z', label: 'Front', caption: null, source: 'member', url: 'https://signed/x' },
    ])
    expect(json.data[0]).not.toHaveProperty('storage_path')
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
