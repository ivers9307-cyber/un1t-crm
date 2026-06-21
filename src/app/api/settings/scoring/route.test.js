import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT, GET, ScoringSchema } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

function putReq(body) {
  return new Request('http://x/api/settings/scoring', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

// A manager whose assignments include loc1 (assertLocationAccess reads user.locations).
const manager = { id: 'u', role: 'manager', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }

const validBody = {
  zone_points: { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 },
  participation_points: 75,
}

// Mock a locations row whose settings already has a sibling key, so we can
// prove the merge-write doesn't clobber it.
function mockDb(existingSettings = {}) {
  let written = null
  createServerClient.mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { name: 'Stillorgan', settings: existingSettings }, error: null }) }) }),
      update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
    }),
  })
  return () => written
}

describe('PUT /api/settings/scoring — auth gate', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq(validBody))).status).toBe(401)
  })

  it('403 for a non-manager (staff)', async () => {
    getCurrentUser.mockResolvedValue({ ...manager, role: 'staff' })
    expect((await PUT(putReq(validBody))).status).toBe(403)
  })

  it('200 for a manager', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb()
    expect((await PUT(putReq(validBody))).status).toBe(200)
  })
})

describe('PUT /api/settings/scoring — merge write', () => {
  it('persists zone_points + participation_points under settings.scoring', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const getWritten = mockDb()
    const res = await PUT(putReq(validBody))
    expect(res.status).toBe(200)
    const written = getWritten()
    expect(written.settings.scoring).toEqual({
      zone_points: { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 },
      participation_points: 75,
    })
  })

  it('does NOT clobber sibling settings keys (customer_agent)', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const getWritten = mockDb({ customer_agent: { enabled: true, agent_name: 'Mia' }, social_enabled: true })
    const res = await PUT(putReq(validBody))
    expect(res.status).toBe(200)
    const written = getWritten()
    // sibling keys survive the merge
    expect(written.settings.customer_agent).toEqual({ enabled: true, agent_name: 'Mia' })
    expect(written.settings.social_enabled).toBe(true)
    // and the new key is present
    expect(written.settings.scoring.participation_points).toBe(75)
  })

  it('echoes the saved scoring in the response', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb()
    const res = await PUT(putReq(validBody))
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.scoring.zone_points[3]).toBe(4)
  })
})

describe('PUT /api/settings/scoring — Zod rejection', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(manager))

  it('400 on a negative zone rate', async () => {
    expect((await PUT(putReq({ ...validBody, zone_points: { 1: -1, 2: 2, 3: 3, 4: 4, 5: 5 } }))).status).toBe(400)
  })

  it('400 on a non-integer zone rate', async () => {
    expect((await PUT(putReq({ ...validBody, zone_points: { 1: 1.5, 2: 2, 3: 3, 4: 4, 5: 5 } }))).status).toBe(400)
  })

  it('400 on a zone rate above the upper bound (100)', async () => {
    expect((await PUT(putReq({ ...validBody, zone_points: { 1: 101, 2: 2, 3: 3, 4: 4, 5: 5 } }))).status).toBe(400)
  })

  it('400 when a zone is missing', async () => {
    expect((await PUT(putReq({ ...validBody, zone_points: { 1: 1, 2: 2, 3: 3, 4: 4 } }))).status).toBe(400)
  })

  it('400 on negative participation_points', async () => {
    expect((await PUT(putReq({ ...validBody, participation_points: -5 }))).status).toBe(400)
  })

  it('400 on participation_points above the upper bound (1000)', async () => {
    expect((await PUT(putReq({ ...validBody, participation_points: 1001 }))).status).toBe(400)
  })

  it('400 on garbage (string) participation_points', async () => {
    expect((await PUT(putReq({ ...validBody, participation_points: 'lots' }))).status).toBe(400)
  })
})

describe('ScoringSchema (unit)', () => {
  it('accepts a well-formed config', () => {
    expect(ScoringSchema.safeParse(validBody).success).toBe(true)
  })
  it('rejects an extra-low (negative) and non-int in one pass', () => {
    expect(ScoringSchema.safeParse({ zone_points: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, participation_points: 0 }).success).toBe(true)
    expect(ScoringSchema.safeParse({ zone_points: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, participation_points: 0.5 }).success).toBe(false)
  })
})

describe('GET /api/settings/scoring', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
  })

  it('returns resolved snake_case scoring (defaults fill missing values)', async () => {
    getCurrentUser.mockResolvedValue(manager)
    // settings.scoring only overrides Z5; the rest must fall back to defaults.
    mockDb({ scoring: { zone_points: { 5: 9 } } })
    const res = await GET()
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.scoring.zone_points[5]).toBe(9)
    expect(json.scoring.zone_points[1]).toBe(1) // default
    expect(json.scoring.participation_points).toBe(50) // default
  })
})
