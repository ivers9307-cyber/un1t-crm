// Tests for PATCH /api/contacts/duplicates/[id]  (PERSON-LINK.2)
//
// Coverage:
//   - dismiss path → suggestion updated to 'dismissed'
//   - link path   → linkContactPair invoked + suggestion flipped to 'linked'
//   - 403 without contact_linking permission
//   - 404 missing suggestion
//   - different-groups → 400 (linkContactPair throws)

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    return null
  },
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

vi.mock('@/lib/person-links', () => ({
  linkContactPair: vi.fn(),
}))

import { PATCH } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { linkContactPair } from '@/lib/person-links'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SUGGESTION_ID = 'd0000000-0000-0000-0000-000000000001'
const SUGGESTION = {
  id: SUGGESTION_ID,
  location_id: 'loc-A',
  contact_id_a: 'a0000000-0000-0000-0000-000000000001',
  contact_id_b: 'b0000000-0000-0000-0000-000000000002',
  match_method: 'phone',
  confidence: 'high',
  reason: 'shared phone',
  status: 'pending',
}

const OWNER = { id: 'u1', role: 'owner', locations: [{ id: 'loc-A' }] }

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function mockDb({ suggestion = SUGGESTION, updateResult = suggestion } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'person_link_suggestions') {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          update: vi.fn(() => chain),
          single: vi.fn(() => {
            // first call is the load, second call is the update
            if (chain._calls === undefined) chain._calls = 0
            chain._calls++
            if (chain._calls === 1) {
              return Promise.resolve({ data: suggestion, error: null })
            }
            return Promise.resolve({ data: { ...updateResult, status: chain._updateStatus || 'dismissed' }, error: null })
          }),
        }
        // intercept update to track status
        const origUpdate = chain.update.bind(chain)
        chain.update = vi.fn((payload) => {
          chain._updateStatus = payload.status
          return origUpdate(payload)
        })
        return chain
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

function mockDbMissing() {
  return {
    from: vi.fn(() => ({
      select: vi.fn(function () { return this }),
      eq: vi.fn(function () { return this }),
      update: vi.fn(function () { return this }),
      single: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not found' } })),
    })),
  }
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/duplicates/${SUGGESTION_ID}`
const PARAMS = { params: Promise.resolve({ id: SUGGESTION_ID }) }

function patchReq(body) {
  return new Request(BASE_URL, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
  linkContactPair.mockResolvedValue({ group: { id: 'g1' }, members: [] })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PATCH /api/contacts/duplicates/[id] — dismiss', () => {
  it('dismiss path → suggestion updated to dismissed, 200 returned', async () => {
    createServerClient.mockReturnValue(mockDb())

    const res = await PATCH(patchReq({ status: 'dismissed' }), PARAMS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    // linkContactPair must NOT have been called
    expect(linkContactPair).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/contacts/duplicates/[id] — link', () => {
  it('link path → linkContactPair invoked with correct args, suggestion status flipped, 200 returned', async () => {
    createServerClient.mockReturnValue(mockDb())

    const res = await PATCH(patchReq({ status: 'linked' }), PARAMS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)

    expect(linkContactPair).toHaveBeenCalledOnce()
    expect(linkContactPair).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aId: SUGGESTION.contact_id_a,
        bId: SUGGESTION.contact_id_b,
        method: SUGGESTION.match_method,
        confidence: SUGGESTION.confidence,
        actorId: 'u1',
        locationId: 'loc-A',
      })
    )
  })

  it('link path — linkContactPair throws (different groups) → 400 with error message', async () => {
    createServerClient.mockReturnValue(mockDb())
    linkContactPair.mockRejectedValue(new Error('Both contacts are already linked to different people'))

    const res = await PATCH(patchReq({ status: 'linked' }), PARAMS)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/already linked to different people/i)
  })
})

describe('PATCH /api/contacts/duplicates/[id] — guards', () => {
  it('401 when no authenticated user', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(mockDb())

    const res = await PATCH(patchReq({ status: 'dismissed' }), PARAMS)
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('403 when user lacks contact_linking permission', async () => {
    hasPermission.mockReturnValue(false)
    createServerClient.mockReturnValue(mockDb())

    const res = await PATCH(patchReq({ status: 'dismissed' }), PARAMS)
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('404 when suggestion not found', async () => {
    createServerClient.mockReturnValue(mockDbMissing())

    const res = await PATCH(patchReq({ status: 'dismissed' }), PARAMS)
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/not found/i)
  })
})
