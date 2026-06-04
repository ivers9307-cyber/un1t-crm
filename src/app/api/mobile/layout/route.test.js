import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
const upsert = vi.fn(() => ({ error: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: () => ({ upsert }) }) }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'

// loc1 must be a UUID-shaped string to pass the uuidLike Zod validator.
const LOC1 = 'a0000000-0000-0000-0000-000000000001'

function req(body) {
  return new Request('http://x/api/mobile/layout', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('PUT /api/mobile/layout', () => {
  beforeEach(() => { upsert.mockClear() })

  it('clamps the bar to the admin allowed set + caps at 3', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'u1', role: 'manager', employment_type: 'fte',
      locations: [{ id: LOC1 }],
      rolesByLocation: { [LOC1]: 'manager' },
      assignmentsByLocation: { [LOC1]: { permissions: { mobile: {} } } },
    })
    const res = await PUT(req({ location_id: LOC1, bar: ['pipeline', 'tasks', 'schedule', 'whatsapp'] }))
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.bar).toEqual(['pipeline', 'schedule', 'whatsapp']) // 'tasks' dropped; capped 3
    expect(upsert).toHaveBeenCalledOnce()
    expect(upsert.mock.calls[0][0]).toMatchObject({ profile_id: 'u1', location_id: LOC1, bar: ['pipeline', 'schedule', 'whatsapp'] })
  })

  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(req({ location_id: LOC1, bar: [] }))
    expect(res.status).toBe(401)
  })
})
