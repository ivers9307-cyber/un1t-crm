import { describe, it, expect, vi, beforeEach } from 'vitest'

// Modelled on ../route.test.js: the route judges MANAGER_ROLES at the location
// with the real per-location helpers, so the fixtures carry rolesByLocation.
vi.mock('@/lib/auth', async () => {
  const { hasRoleAtLocation, hasRoleAtAnyLocation } = await import('@/lib/role-at-location')
  return { getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), hasRoleAtLocation, hasRoleAtAnyLocation }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const CLASSES = [
  { glofox_event_id: 'e1', name: 'HYROX', starts_at: '2026-10-25T09:00:00Z', ends_at: '2026-10-25T10:00:00Z', capacity: 20, instructor: 'A', synced_at: '2026-10-24T08:00:00Z' },
]

function get(key, query = `?location_id=${LOC}`) {
  return GET({ url: `http://localhost/api/automations/${key}/schedule${query}` }, { params: Promise.resolve({ key }) })
}

// Recording fake of class_occurrences: every chained call is kept so the test
// can assert the read was scoped to the location.
function fakeDb({ data = CLASSES, error = null } = {}) {
  const calls = { table: null, eq: [] }
  const q = {
    select: () => q,
    eq: (c, v) => { calls.eq.push([c, v]); return q },
    gte: () => q,
    is: () => q,
    order: () => q,
    limit: async () => ({ data, error }),
  }
  return { calls, client: { from: (t) => { calls.table = t; return q } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  getCurrentUser.mockResolvedValue({ role: 'manager', id: 'u1', rolesByLocation: { [LOC]: 'manager' } })
})

describe('GET /api/automations/[key]/schedule', () => {
  it.each(['class_climate', 'bathroom_climate', 'screen_mode'])('answers for %s with the location\'s classes', async (key) => {
    const { calls, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await get(key)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.classes).toEqual(CLASSES)
    expect(body.last_synced).toBe('2026-10-24T08:00:00Z')
    expect(calls.table).toBe('class_occurrences')
    expect(calls.eq).toContainEqual(['location_id', LOC])
  })

  it('still refuses an unsupported key, before touching the database', async () => {
    const res = await get('glofox_lead_provisioning')
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403 for screen_mode when the caller is not a manager at the location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', id: 'u2', rolesByLocation: { [LOC]: 'staff' } })
    const res = await get('screen_mode')
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('400 when location_id is missing or not uuid-shaped', async () => {
    expect((await get('screen_mode', '')).status).toBe(400)
    expect((await get('screen_mode', '?location_id=nope')).status).toBe(400)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('honours the location guard (assertLocationAccess)', async () => {
    const { NextResponse } = await import('next/server')
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    const res = await get('screen_mode')
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })
})
