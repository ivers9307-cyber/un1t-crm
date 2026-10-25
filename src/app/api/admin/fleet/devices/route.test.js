import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logInfo } from '@/lib/log'
import { makeFakeDb, writesOf, jsonRequest, LOC_A, TV_ID, OWNER_A } from '@/lib/tv-admin.test-helpers'

const MASTER = { id: 'user-m', isMaster: true }
const BODY = { device_name: 'hatch-screen1', location_id: LOC_A, role: 'screen', label: 'Hatch screen 1', tv_display_id: TV_ID }

// tv_displays read answers `display`; the insert answers `inserted`.
function fakeDb({ display = { id: TV_ID }, displayError = null, inserted, insertError = null } = {}) {
  const db = makeFakeDb((call) => {
    if (call.table === 'tv_displays') return { data: display, error: displayError }
    if (call.op === 'insert') {
      return insertError
        ? { data: null, error: insertError }
        : { data: inserted ?? { ...call.payload }, error: null }
    }
    return { data: null, error: null }
  })
  createServerClient.mockReturnValue(db)
  return db
}

const post = (body) => POST(jsonRequest('/api/admin/fleet/devices', 'POST', body))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('POST /api/admin/fleet/devices', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    const db = fakeDb()
    const res = await post(BODY)
    expect(res.status).toBe(401)
    expect(db.calls).toHaveLength(0)
  })

  it('403 for a non-master owner', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const db = fakeDb()
    const res = await post(BODY)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Master only' })
    expect(db.calls).toHaveLength(0)
  })

  it('refuses a Pi role on create', async () => {
    const db = fakeDb()
    const res = await post({ ...BODY, role: 'kiosk' })
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('refuses a malformed device name', async () => {
    const db = fakeDb()
    const res = await post({ ...BODY, device_name: 'Hatch Screen!' })
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('refuses a display at another studio', async () => {
    const db = fakeDb({ display: null })
    const res = await post(BODY)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'display_not_at_location' })
    expect(writesOf(db)).toHaveLength(0)
  })

  it('creates a screen and returns 201', async () => {
    const db = fakeDb()
    const res = await post(BODY)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.device).toMatchObject({ device_name: 'hatch-screen1', location_id: LOC_A, role: 'screen', tv_display_id: TV_ID })
    const [insert] = writesOf(db)
    expect(insert.table).toBe('fleet_devices')
    expect(insert.op).toBe('insert')
    expect(insert.payload).toEqual({
      device_name: 'hatch-screen1', location_id: LOC_A, role: 'screen', label: 'Hatch screen 1', tv_display_id: TV_ID,
    })
    expect(insert.columns).toBe('device_name, location_id, role, label, tv_display_id')
    expect(logInfo).toHaveBeenCalledWith('fleet-cmd', 'screen registered', { device: 'hatch-screen1', by: 'user-m' })
  })

  it('creates a screen with no display or label (nulls, no display read)', async () => {
    const db = fakeDb()
    const res = await post({ device_name: 'hatch-screen2', location_id: LOC_A, role: 'screen' })
    expect(res.status).toBe(201)
    expect(db.calls.filter((c) => c.table === 'tv_displays')).toHaveLength(0)
    expect(writesOf(db)[0].payload).toEqual({
      device_name: 'hatch-screen2', location_id: LOC_A, role: 'screen', label: null, tv_display_id: null,
    })
  })

  it('409 when the name exists', async () => {
    fakeDb({ insertError: { code: '23505', message: 'duplicate key' } })
    const res = await post(BODY)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'exists' })
  })

  it('500 on any other insert error', async () => {
    fakeDb({ insertError: { code: '42P01', message: 'boom' } })
    const res = await post(BODY)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not create device' })
  })
})
