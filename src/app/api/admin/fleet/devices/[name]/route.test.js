import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { PATCH } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { makeFakeDb, writesOf, jsonRequest, LOC_A, TV_ID, OWNER_A } from '@/lib/tv-admin.test-helpers'

const MASTER = { id: 'user-m', isMaster: true }
const ctx = (name = 'hatch-screen1') => ({ params: Promise.resolve({ name }) })

function fakeDb({ display = { id: TV_ID }, updated } = {}) {
  const db = makeFakeDb((call) => {
    if (call.table === 'tv_displays') return { data: display, error: null }
    if (call.op === 'update') return { data: updated === undefined ? { device_name: 'hatch-screen1', ...call.payload } : updated, error: null }
    return { data: null, error: null }
  })
  createServerClient.mockReturnValue(db)
  return db
}

const patch = (body, name) => PATCH(jsonRequest('/api/admin/fleet/devices/x', 'PATCH', body), ctx(name))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('PATCH /api/admin/fleet/devices/[name]', () => {
  it('403 for a non-master owner', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const db = fakeDb()
    const res = await patch({ location_id: LOC_A, role: 'screen' })
    expect(res.status).toBe(403)
    expect(db.calls).toHaveLength(0)
  })

  it('claims a discovered device as a screen with a display', async () => {
    const db = fakeDb()
    const res = await patch({ location_id: LOC_A, role: 'screen', label: 'Hatch 1', tv_display_id: TV_ID })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.device.tv_display_id).toBe(TV_ID)
    const [update] = writesOf(db)
    expect(update.payload).toMatchObject({ location_id: LOC_A, role: 'screen', label: 'Hatch 1', tv_display_id: TV_ID })
    expect(update.columns).toBe('device_name, location_id, role, label, tv_display_id')
    const read = db.calls.find((c) => c.table === 'tv_displays')
    expect(read.filters).toEqual(expect.arrayContaining([['eq', 'id', TV_ID], ['eq', 'location_id', LOC_A], ['eq', 'active', true]]))
  })

  it('still claims a kiosk with no display', async () => {
    const db = fakeDb()
    const res = await patch({ location_id: LOC_A, role: 'kiosk', label: 'Front desk' })
    expect(res.status).toBe(200)
    expect(db.calls.filter((c) => c.table === 'tv_displays')).toHaveLength(0)
    const [update] = writesOf(db)
    expect(update.payload).not.toHaveProperty('tv_display_id')
    expect(update.payload).toMatchObject({ location_id: LOC_A, role: 'kiosk', label: 'Front desk' })
  })

  it('clears the display link when tv_display_id is null', async () => {
    const db = fakeDb()
    const res = await patch({ location_id: LOC_A, role: 'screen', tv_display_id: null })
    expect(res.status).toBe(200)
    expect(db.calls.filter((c) => c.table === 'tv_displays')).toHaveLength(0)
    expect(writesOf(db)[0].payload.tv_display_id).toBeNull()
  })

  it('refuses a display at another studio before any write', async () => {
    const db = fakeDb({ display: null })
    const res = await patch({ location_id: LOC_A, role: 'screen', tv_display_id: TV_ID })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'display_not_at_location' })
    expect(writesOf(db)).toHaveLength(0)
  })

  it('404 when the device does not exist', async () => {
    fakeDb({ updated: null })
    const res = await patch({ location_id: LOC_A, role: 'kiosk' }, 'nope')
    expect(res.status).toBe(404)
  })
})
