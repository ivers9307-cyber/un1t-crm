// src/app/api/live/[locationId]/detections/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc1']),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/hr-detections', () => ({
  resolveDetectionLinks: vi.fn(async (_db, { detections }) => detections.map((d) => ({ ...d, linked_contact: null, live_now: false }))),
}))

import { GET } from './route'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function makeReq() { return new Request('http://localhost/api/live/loc1/detections') }
const props = { params: Promise.resolve({ locationId: 'loc1' }) }

// SEC-LIVE-API.1 — the gate now also requires `studio_management` at the
// location, so fixtures need the shape hasPermissionForLocation reads.
function userAt(role, { studio = true, locationId = 'loc1' } = {}) {
  return {
    id: 'u1',
    role,
    isMaster: false,
    locations: [{ id: locationId, features: {} }],
    assignmentsByLocation: {
      [locationId]: { role, permissions: studio === null ? {} : { studio_management: studio } },
    },
    roleTemplatesByLocation: {},
  }
}

beforeEach(() => { vi.clearAllMocks(); getUserLocationIds.mockReturnValue(['loc1']) })

describe('GET /api/live/[locationId]/detections', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(401)
  })

  it('403 when the location is not in scope', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    getUserLocationIds.mockReturnValue(['other'])
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(403)
  })

  it('200 returns enriched detections', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [{ id: 'd1', device_key: 'ant:1' }], error: null }) }) }) }),
      }),
    })
    const res = await GET(makeReq(), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.detections[0]).toMatchObject({ device_key: 'ant:1', linked_contact: null, live_now: false })
  })
})
