// SCREENMODE.6 — GET /api/fleet/screen-plan: the box's heartbeat and plan.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb, writesOf, readsOf, LOC_A } from '@/lib/tv-admin.test-helpers'

const { verifyFleetDeviceToken, buildScreenPlan, checkRateLimit, logWarn, logError } = vi.hoisted(() => ({
  verifyFleetDeviceToken: vi.fn(),
  buildScreenPlan: vi.fn(),
  checkRateLimit: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/fleet-device-auth', () => ({ verifyFleetDeviceToken }))
vi.mock('@/lib/screen-plan', () => ({
  buildScreenPlan,
  SCREEN_DEVICE_COLUMNS: 'device_name, role, location_id, tv_display_id, override_mode, override_until',
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit,
  rateLimitResponse: () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
}))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn, logError }))

import { GET } from './route'

const SCREEN_AUTH = { device_name: 'hatch-tv1', role: 'screen', location_id: LOC_A }
const SCREEN_ROW = {
  device_name: 'hatch-tv1', role: 'screen', location_id: LOC_A,
  tv_display_id: null, override_mode: null, override_until: null,
}
const PLAN = { ok: true, poll_seconds: 600, windows: [] }

const req = (query = '') =>
  new Request(`http://t/api/fleet/screen-plan${query}`, { headers: { authorization: 'Bearer fdv_x' } })

const stamps = () => writesOf(db).filter((c) => c.table === 'fleet_devices' && c.op === 'update')

function makeDb({ row = SCREEN_ROW, readError = null, updateError = null } = {}) {
  return makeFakeDb((call) => {
    if (call.table === 'fleet_devices' && call.op === 'select') {
      return { data: readError ? null : row, error: readError }
    }
    if (call.table === 'fleet_devices' && call.op === 'update') return { data: null, error: updateError }
    return { data: null, error: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  verifyFleetDeviceToken.mockResolvedValue(SCREEN_AUTH)
  buildScreenPlan.mockResolvedValue(PLAN)
  checkRateLimit.mockResolvedValue({ allowed: true })
})

describe('GET /api/fleet/screen-plan', () => {
  it('401 with no device', async () => {
    verifyFleetDeviceToken.mockResolvedValue(null)
    const res = await GET(req('?mode=marketing'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorised' })
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(db.calls).toHaveLength(0)
    expect(buildScreenPlan).not.toHaveBeenCalled()
  })

  it('a non-screen device is refused and not stamped', async () => {
    verifyFleetDeviceToken.mockResolvedValue({ device_name: 'stillorgan-tv1', role: 'kiosk', location_id: LOC_A })
    const res = await GET(req('?mode=marketing'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'Not found' })
    expect(writesOf(db)).toHaveLength(0)
    expect(readsOf(db)).toHaveLength(0)
    expect(buildScreenPlan).not.toHaveBeenCalled()
  })

  it('a screen with no studio is refused like a non-screen: nothing read or written, no plan', async () => {
    verifyFleetDeviceToken.mockResolvedValue({ device_name: 'hatch-tv1', role: 'screen', location_id: null })
    const res = await GET(req('?mode=marketing'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'Not found' })
    expect(db.calls).toHaveLength(0)
    expect(buildScreenPlan).not.toHaveBeenCalled()
  })

  it('stamps the heartbeat, mode and version, then returns the plan', async () => {
    const before = Date.now()
    const res = await GET(req('?mode=class_app&version=1.0.3'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(PLAN)
    expect(body.poll_seconds).toBe(600)

    const [stamp] = stamps()
    expect(stamps()).toHaveLength(1)
    expect(stamp.payload).toMatchObject({ reported_mode: 'class_app', reported_version: '1.0.3' })
    expect(Object.keys(stamp.payload).sort()).toEqual(
      ['last_heartbeat_at', 'reported_mode', 'reported_version', 'updated_at'],
    )
    expect(stamp.payload.last_heartbeat_at).toBe(stamp.payload.updated_at)
    expect(Date.parse(stamp.payload.last_heartbeat_at)).toBeGreaterThanOrEqual(before)
    expect(stamp.filters).toContainEqual(['eq', 'device_name', 'hatch-tv1'])
  })

  it('reads the device row by name with the shared column list, and plans from that row', async () => {
    await GET(req('?mode=marketing'))
    const [read] = readsOf(db, 'fleet_devices')
    expect(read.columns).toBe('device_name, role, location_id, tv_display_id, override_mode, override_until')
    expect(read.filters).toContainEqual(['eq', 'device_name', 'hatch-tv1'])
    expect(read.filters).toContainEqual(['eq', 'location_id', LOC_A])
    expect(buildScreenPlan).toHaveBeenCalledTimes(1)
    const [passedDb, device, opts] = buildScreenPlan.mock.calls[0]
    expect(passedDb).toBe(db)
    expect(device).toEqual(SCREEN_ROW)
    expect(typeof opts.nowMs).toBe('number')
  })

  it("an unlisted mode is stored as 'unknown'", async () => {
    await GET(req('?mode=rm_-rf&version=2'))
    expect(stamps()[0].payload).toMatchObject({ reported_mode: 'unknown', reported_version: '2' })
  })

  it("a missing mode is stored as 'unknown' and a missing version as null", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stamps()[0].payload).toMatchObject({ reported_mode: 'unknown', reported_version: null })
  })

  it('trims the version to 40 chars, and a blank version is null', async () => {
    await GET(req(`?mode=marketing&version=${'v'.repeat(80)}`))
    expect(stamps()[0].payload.reported_version).toBe('v'.repeat(40))
    db = makeDb()
    await GET(req('?mode=marketing&version=%20%20'))
    expect(stamps()[0].payload.reported_version).toBeNull()
  })

  it('429 when the limiter says no, before any read or write', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSec: 30 })
    const res = await GET(req('?mode=marketing'))
    expect(res.status).toBe(429)
    expect(checkRateLimit).toHaveBeenCalledWith(db, 'screen-plan:hatch-tv1', { max: 30, windowMs: 60_000 })
    expect(db.calls).toHaveLength(0)
    expect(buildScreenPlan).not.toHaveBeenCalled()
  })

  it('a non-screen device still spends from the limiter (checked before the role check)', async () => {
    verifyFleetDeviceToken.mockResolvedValue({ device_name: 'stillorgan-tv1', role: 'kiosk', location_id: LOC_A })
    await GET(req())
    expect(checkRateLimit).toHaveBeenCalledWith(db, 'screen-plan:stillorgan-tv1', { max: 30, windowMs: 60_000 })
  })

  it('500 Lookup failed when the device row cannot be read; nothing stamped or planned', async () => {
    db = makeDb({ readError: { message: 'boom' } })
    const res = await GET(req('?mode=marketing'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Lookup failed' })
    expect(logWarn).toHaveBeenCalledWith('screen-plan', expect.any(String), expect.anything())
    expect(writesOf(db)).toHaveLength(0)
    expect(buildScreenPlan).not.toHaveBeenCalled()
  })

  it('500 Lookup failed when the device row is missing', async () => {
    db = makeDb({ row: null })
    const res = await GET(req('?mode=marketing'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Lookup failed' })
    expect(logWarn).toHaveBeenCalled()
    expect(writesOf(db)).toHaveLength(0)
    expect(buildScreenPlan).not.toHaveBeenCalled()
  })

  it('a failed stamp is logged and the plan is still returned', async () => {
    db = makeDb({ updateError: { message: 'write refused' } })
    const res = await GET(req('?mode=class_app&version=1.0.3'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(PLAN)
    expect(stamps()).toHaveLength(1)
    expect(logWarn).toHaveBeenCalledWith('screen-plan', expect.any(String), expect.anything())
  })

  it('500 Plan unavailable when the plan cannot be built, logged without the token', async () => {
    buildScreenPlan.mockRejectedValue(new Error('APP_URL is not set'))
    const res = await GET(req('?mode=marketing'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Plan unavailable' })
    expect(logError).toHaveBeenCalledWith('screen-plan', 'plan build failed', { device: 'hatch-tv1' })
  })

  it('never logs the bearer token', async () => {
    db = makeDb({ updateError: { message: 'x' } })
    await GET(req('?mode=marketing'))
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('fdv_x')
  })
})
