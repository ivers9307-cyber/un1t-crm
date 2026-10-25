// SETTINGSWIPE.1 — /api/settings/status-page. PUT discarded its read error,
// wrote the WHOLE settings column, discarded the write result and answered
// success. GET answered a failed read as "no overrides".

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const USER = { id: 'u1', role: 'owner', locations: [{ id: LOC }], activeLocation: { id: LOC } }
const put = (body) => new Request('http://localhost/api/settings/status-page', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(USER) })

describe('GET', () => {
  it('a failed read → 500, no overrides', async () => {
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: { data: null, error: BOOM } }))
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).overrides).toBeUndefined()
  })
})

describe('PUT', () => {
  it('a failed read → 500, NOTHING written', async () => {
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ brand: 'Studio' }))
    expect(res.status).toBe(500)
    expect(db.writes).toEqual([])
  })
  it('a failed write → 500 (was success:true)', async () => {
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: { data: { settings: {} }, error: null }, write: { data: null, error: BOOM } }))
    expect((await PUT(put({ brand: 'Studio' }))).status).toBe(500)
  })
  it('pin: overrides set status_page and keep siblings', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: { branch_id: 'b1' } } }, error: null } })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ brand: 'Studio' }))).status).toBe(200)
    expect(db.writes[0].patch.settings).toEqual({ glofox: { branch_id: 'b1' }, status_page: { brand: 'Studio' } })
  })
  it('pin: an all-default form drops the key and keeps siblings', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: {}, status_page: { brand: 'Old' } } }, error: null } })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({}))).status).toBe(200)
    expect(db.writes[0].patch.settings).toEqual({ glofox: {} })
  })
})
