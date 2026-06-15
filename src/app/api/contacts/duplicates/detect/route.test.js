// Tests for POST /api/contacts/duplicates/detect (PERSON-LINK.2)
//
// Coverage:
//   - dry-run (commit=false, default) → calls runDetection with commit:false, 200 + data
//   - commit=true → calls runDetection with commit:true, 200 + data
//   - location_id from body overrides active location
//   - location_id falls back to user.activeLocation.id when not in body
//   - missing location_id (no body, no activeLocation) → 400
//   - no contact_linking permission → 403
//   - unauthenticated → 401
//   - cross-location access → 403 (assertLocationAccess guard)
//   - runDetection throws → 500 JSON with success:false

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(
        JSON.stringify({ success: false, error: 'Forbidden' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

vi.mock('@/lib/person-detect', () => ({
  runDetection: vi.fn(),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { runDetection } from '@/lib/person-detect'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const OWNER = {
  id: 'u1',
  role: 'owner',
  locations: [{ id: LOC_A }],
  activeLocation: { id: LOC_A },
}

const DRY_RUN_RESULT = {
  dryRun: true,
  counts: { high: 1, medium: 0, low: 0 },
  autoLinkCount: 1,
  totalCandidates: 1,
  sample: [],
}

const COMMIT_RESULT = {
  dryRun: false,
  counts: { high: 1, medium: 0, low: 0 },
  autoLinked: 1,
  skipped: 0,
  totalCandidates: 1,
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost/api/contacts/duplicates/detect'

function postReq(body = {}, { queryString = '' } = {}) {
  const url = queryString ? `${BASE_URL}${queryString}` : BASE_URL
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postReqNoBody({ queryString = '' } = {}) {
  const url = queryString ? `${BASE_URL}${queryString}` : BASE_URL
  return new Request(url, { method: 'POST' })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
  hasPermission.mockReturnValue(true)
  createServerClient.mockReturnValue({})
  runDetection.mockResolvedValue(DRY_RUN_RESULT)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/contacts/duplicates/detect — dry-run', () => {
  it('default (no ?commit) → commit=false passed to runDetection, 200 + data', async () => {
    const res = await POST(postReq({ location_id: LOC_A }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toEqual(DRY_RUN_RESULT)

    expect(runDetection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: LOC_A, commit: false, actorId: 'u1' })
    )
  })

  it('?commit=false explicitly → same dry-run behaviour', async () => {
    const res = await POST(postReq({ location_id: LOC_A }, { queryString: '?commit=false' }))
    expect(res.status).toBe(200)
    expect(runDetection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commit: false })
    )
  })
})

describe('POST /api/contacts/duplicates/detect — commit', () => {
  it('?commit=true → commit:true passed to runDetection, 200 + data', async () => {
    runDetection.mockResolvedValue(COMMIT_RESULT)

    const res = await POST(postReq({ location_id: LOC_A }, { queryString: '?commit=true' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toEqual(COMMIT_RESULT)

    expect(runDetection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: LOC_A, commit: true, actorId: 'u1' })
    )
  })
})

describe('POST /api/contacts/duplicates/detect — location resolution', () => {
  it('location_id from body used when provided', async () => {
    const res = await POST(postReq({ location_id: LOC_A }))
    expect(res.status).toBe(200)
    expect(runDetection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: LOC_A })
    )
  })

  it('falls back to user.activeLocation.id when location_id not in body', async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(200)
    expect(runDetection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: LOC_A })
    )
  })

  it('returns 400 when no location_id and no activeLocation', async () => {
    getCurrentUser.mockResolvedValue({ ...OWNER, activeLocation: null })

    const res = await POST(postReq({}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/location_id/i)
    expect(runDetection).not.toHaveBeenCalled()
  })
})

describe('POST /api/contacts/duplicates/detect — auth guards', () => {
  it('unauthenticated → 401', async () => {
    getCurrentUser.mockResolvedValue(null)

    const res = await POST(postReq({ location_id: LOC_A }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(runDetection).not.toHaveBeenCalled()
  })

  it('no contact_linking permission → 403', async () => {
    hasPermission.mockReturnValue(false)

    const res = await POST(postReq({ location_id: LOC_A }))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(runDetection).not.toHaveBeenCalled()
  })

  it('cross-location access → 403 (assertLocationAccess guard)', async () => {
    // LOC_B is not in OWNER.locations
    const res = await POST(postReq({ location_id: LOC_B }))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(runDetection).not.toHaveBeenCalled()
  })
})

describe('POST /api/contacts/duplicates/detect — empty body handling', () => {
  it('empty body (no Content-Type) falls back to activeLocation', async () => {
    const res = await POST(postReqNoBody())
    expect(res.status).toBe(200)
    expect(runDetection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: LOC_A })
    )
  })
})

describe('POST /api/contacts/duplicates/detect — runDetection error handling', () => {
  it('runDetection throws → 500 JSON with success:false', async () => {
    runDetection.mockRejectedValue(new Error('person_link_suggestions does not exist'))

    const res = await POST(postReq({ location_id: LOC_A }))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('person_link_suggestions does not exist')
  })

  it('runDetection throws without message → 500 with fallback message', async () => {
    runDetection.mockRejectedValue(new Error())

    const res = await POST(postReq({ location_id: LOC_A }))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('Detection failed')
  })
})
