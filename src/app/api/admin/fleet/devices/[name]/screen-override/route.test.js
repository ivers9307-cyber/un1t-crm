import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/screen-doorbell', () => ({ ringScreens: vi.fn(async () => 1) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ringScreens } from '@/lib/screen-doorbell'
import { logInfo, logWarn } from '@/lib/log'
import { makeFakeDb, writesOf, jsonRequest, LOC_A, LOC_B } from '@/lib/tv-admin.test-helpers'
import { person } from '../../../../../../../../tests/helpers/role-sweep-callers.js'

const MASTER = { id: 'user-m', isMaster: true }
// Real permission resolution (no mocked hasPermissionForLocation): an owner
// holds fleet_restart at A only when the key is switched on there.
const owner = (permissions) => ({ role: 'owner', ...(permissions ? { permissions } : {}) })
const HOLDER_AT_A = person({ [LOC_A]: owner({ fleet_restart: true }), [LOC_B]: owner({ fleet_restart: false }) }, LOC_A)
const HOLDER_AT_B_ONLY = person({ [LOC_A]: owner({ fleet_restart: false }), [LOC_B]: owner({ fleet_restart: true }) }, LOC_B)
const NO_KEY_AT_A = person({ [LOC_A]: owner({ fleet_restart: false }) }, LOC_A)

const SCREEN = { device_name: 'hatch-screen1', role: 'screen', location_id: LOC_A }
const ctx = (name = 'hatch-screen1') => ({ params: Promise.resolve({ name }) })

function fakeDb({ device = SCREEN, updateError = null } = {}) {
  const db = makeFakeDb((call) => {
    if (call.table === 'fleet_devices' && call.op === 'select') return { data: device, error: null }
    if (call.op === 'update') return { data: null, error: updateError }
    return { data: null, error: null }
  })
  createServerClient.mockReturnValue(db)
  return db
}

const post = (body, name) => POST(jsonRequest('/api/admin/fleet/devices/x/screen-override', 'POST', body), ctx(name))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('POST /api/admin/fleet/devices/[name]/screen-override', () => {
  it('401 with no session, before any read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const db = fakeDb()
    const res = await post({ clear: true })
    expect(res.status).toBe(401)
    expect(db.calls).toHaveLength(0)
  })

  it('404 for a kiosk, with the same body as an unknown name, and no write', async () => {
    const kioskDb = fakeDb({ device: { device_name: 'pi-1', role: 'kiosk', location_id: LOC_A } })
    const kiosk = await post({ mode: 'marketing', minutes: 30 }, 'pi-1')
    expect(kiosk.status).toBe(404)
    const kioskBody = await kiosk.json()
    expect(writesOf(kioskDb)).toHaveLength(0)
    expect(ringScreens).not.toHaveBeenCalled()

    const missingDb = fakeDb({ device: null })
    const missing = await post({ mode: 'marketing', minutes: 30 }, 'nope')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual(kioskBody)
    expect(kioskBody).toEqual({ ok: false, error: 'Not found' })
    expect(writesOf(missingDb)).toHaveLength(0)
  })

  it('404 for a screen with no studio yet, and no write', async () => {
    const db = fakeDb({ device: { ...SCREEN, location_id: null } })
    const res = await post({ clear: true })
    expect(res.status).toBe(404)
    expect(writesOf(db)).toHaveLength(0)
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('403 for a staffer without fleet_restart at that studio, and no write', async () => {
    getCurrentUser.mockResolvedValue(NO_KEY_AT_A)
    const db = fakeDb()
    const res = await post({ mode: 'class_app', minutes: 60 })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorised' })
    expect(writesOf(db)).toHaveLength(0)
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('403 for a holder of fleet_restart at a different studio only', async () => {
    getCurrentUser.mockResolvedValue(HOLDER_AT_B_ONLY)
    const db = fakeDb()
    const res = await post({ mode: 'class_app', minutes: 60 })
    expect(res.status).toBe(403)
    expect(writesOf(db)).toHaveLength(0)
  })

  it('lets a holder of fleet_restart at the studio set an override', async () => {
    getCurrentUser.mockResolvedValue(HOLDER_AT_A)
    const db = fakeDb()
    const res = await post({ mode: 'marketing', minutes: 30 })
    expect(res.status).toBe(200)
    expect(writesOf(db)).toHaveLength(1)
  })

  it('sets a 60-minute override and rings the device', async () => {
    const db = fakeDb()
    const before = Date.now()
    const res = await post({ mode: 'class_app', minutes: 60 })
    expect(res.status).toBe(200)

    const [update] = writesOf(db)
    expect(update.table).toBe('fleet_devices')
    expect(update.payload.override_mode).toBe('class_app')
    const untilMs = Date.parse(update.payload.override_until)
    expect(Math.abs(untilMs - (before + 60 * 60_000))).toBeLessThanOrEqual(2000)
    expect(typeof update.payload.updated_at).toBe('string')
    // location-scoped as well as name-scoped
    expect(update.filters).toEqual([['eq', 'device_name', 'hatch-screen1'], ['eq', 'location_id', LOC_A]])

    expect(await res.json()).toEqual({ ok: true, override: { mode: 'class_app', until: update.payload.override_until } })
    expect(ringScreens).toHaveBeenCalledWith(['hatch-screen1'])
    expect(logInfo).toHaveBeenCalledWith('fleet-cmd', 'screen override', { device: 'hatch-screen1', mode: 'class_app', by: 'user-m' })
  })

  it('clear nulls both columns and rings the device', async () => {
    const db = fakeDb()
    const res = await post({ clear: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, override: null })
    const [update] = writesOf(db)
    expect(update.payload.override_mode).toBeNull()
    expect(update.payload.override_until).toBeNull()
    expect(ringScreens).toHaveBeenCalledWith(['hatch-screen1'])
    expect(logInfo).toHaveBeenCalledWith('fleet-cmd', 'screen override', { device: 'hatch-screen1', mode: 'clear', by: 'user-m' })
  })

  it('refuses minutes outside the list', async () => {
    const db = fakeDb()
    const res = await post({ mode: 'class_app', minutes: 45 })
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('refuses an unknown mode', async () => {
    const db = fakeDb()
    const res = await post({ mode: 'party', minutes: 30 })
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('500 when the write fails, and the device is not rung', async () => {
    fakeDb({ updateError: { message: 'write refused' } })
    const res = await post({ mode: 'class_app', minutes: 30 })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not set override' })
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('a doorbell that throws does not fail a saved override', async () => {
    fakeDb()
    ringScreens.mockRejectedValueOnce(new Error('realtime down'))
    const res = await post({ mode: 'marketing', minutes: 120 })
    expect(res.status).toBe(200)
    expect((await res.json()).override.mode).toBe('marketing')
    expect(logWarn).toHaveBeenCalled()
  })
})
