// EQUIP-MAINT.3 — route tests for the inspection-day reminder cron.
//
// Uses the REAL src/lib/equipment-cron.js (isInspectionDay,
// selectOutstanding, buildReminderBody) — those are already unit
// tested in isolation, and exercising them for real here is what
// proves the route wires them together correctly rather than just
// proving the mocks were called. Only the DB layer, push, audit,
// heartbeat and "today" are mocked.
//
// 2026-08-04 is a Tuesday (dow 2) — matches equipment-cron.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  today: '2026-08-04',
}))

vi.mock('@/lib/dublin-time', () => ({ dublinTodayStr: () => h.today }))

const updateSpy = vi.fn()
function makeBuilder() {
  const b = {}
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'range', 'in']) b[m] = () => b
  b.update = (...args) => { updateSpy(...args); return b }
  b.then = (resolve) => Promise.resolve({ data: [], error: null }).then(resolve)
  return b
}
const fakeDb = { from: () => makeBuilder() }
vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))

vi.mock('@/lib/equipment-db', () => ({
  listEnabledSettings: vi.fn(),
  listActiveEquipment: vi.fn(),
  listSubmittedSince: vi.fn(),
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn(async () => ({ sent: 1 })),
}))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { GET } from './route.js'
import { listEnabledSettings, listActiveEquipment, listSubmittedSince } from '@/lib/equipment-db'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

const TUESDAY_SETTINGS = { location_id: 'loc-tue', inspection_day_of_week: 2, enabled: true }
const WEDNESDAY_SETTINGS = { location_id: 'loc-wed', inspection_day_of_week: 3, enabled: true }

const ASSETS = [
  { id: 'a', name: 'Treadmill 1', next_due_on: '2026-08-04', status: 'in_service' },
  { id: 'b', name: 'Rower 2', next_due_on: '2026-08-04', status: 'in_service' },
]

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.today = '2026-08-04'
  listEnabledSettings.mockResolvedValue([])
  listActiveEquipment.mockResolvedValue([])
  listSubmittedSince.mockResolvedValue([])
})

describe('GET /api/cron/equipment-inspection-reminder', () => {
  it('rejects a missing bearer with 401', async () => {
    const res = await GET({ headers: { get: () => null } })
    expect(res.status).toBe(401)
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('rejects a wrong bearer with 401', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
  })

  it('skips a location whose inspection weekday is not today — no push, no due-list fetch', async () => {
    listEnabledSettings.mockResolvedValue([WEDNESDAY_SETTINGS])
    await GET(req())
    expect(listActiveEquipment).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('sends no push when nothing is outstanding, even on the inspection weekday', async () => {
    listEnabledSettings.mockResolvedValue([TUESDAY_SETTINGS])
    listActiveEquipment.mockResolvedValue([])
    listSubmittedSince.mockResolvedValue([])
    await GET(req())
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('sends exactly one push with category notify_inspection_due when something is outstanding', async () => {
    listEnabledSettings.mockResolvedValue([TUESDAY_SETTINGS])
    listActiveEquipment.mockResolvedValue(ASSETS)
    listSubmittedSince.mockResolvedValue([])
    await GET(req())
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledWith(
      'loc-tue',
      expect.any(Array),
      expect.objectContaining({ category: 'notify_inspection_due' })
    )
  })

  it('isolates a location that throws — the next location still gets processed', async () => {
    const otherTuesday = { location_id: 'loc-tue-2', inspection_day_of_week: 2, enabled: true }
    listEnabledSettings.mockResolvedValue([TUESDAY_SETTINGS, otherTuesday])
    listActiveEquipment.mockImplementation(async (db, locationId) => {
      if (locationId === 'loc-tue') throw new Error('boom')
      return ASSETS
    })
    listSubmittedSince.mockResolvedValue([])

    const res = await GET(req())
    const body = await res.json()

    expect(body.success).toBe(true)
    // The failing location is recorded as an error, the healthy one
    // as pushed — proving the throw did not abort the loop.
    const byLocation = Object.fromEntries(body.data.locations.map((l) => [l.locationId, l]))
    expect(byLocation['loc-tue'].error).toBeTruthy()
    expect(byLocation['loc-tue-2'].pushed).toBe(true)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledWith(
      'loc-tue-2', expect.any(Array), expect.anything()
    )
  })

  it('calls stampHeartbeat with the exact mig-470 name', async () => {
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('equipment-inspection-reminder')
  })

  it('never issues a direct update against equipment or equipment_inspections', async () => {
    listEnabledSettings.mockResolvedValue([TUESDAY_SETTINGS])
    listActiveEquipment.mockResolvedValue(ASSETS)
    await GET(req())
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
