// SETTINGSWIPE.1 — PUT /api/hyrox/settings discarded its read error and wrote
// the WHOLE settings column (found auditing C23; not in the index row).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const put = (body) => new Request('http://localhost/api/hyrox/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: LOC, ...body }),
})

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', locations: [{ id: LOC }] }) })

describe('PUT /api/hyrox/settings', () => {
  it('a failed read → 500, NOTHING written', async () => {
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ house_style: 'Relays' }))
    expect(res.status).toBe(500)
    expect(db.writes).toEqual([])
  })
  it('pin: merges only the given hyrox sub-keys and keeps every other key', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: {}, hyrox: { charter: 'C', style_examples: [{ text: 'x' }] } } }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ house_style: 'Relays' }))
    expect(res.status).toBe(200)
    expect(db.writes[0].patch.settings).toEqual({ glofox: {}, hyrox: { charter: 'C', style_examples: [{ text: 'x' }], house_style: 'Relays' } })
    expect((await res.json()).data.hyrox.house_style).toBe('Relays')
  })
})
