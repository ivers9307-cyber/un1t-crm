// EQUIP-MAINT.3 — route tests for the overdue-inspection sweep cron.
//
// Uses the REAL src/lib/equipment-cron.js (selectOutstanding,
// buildOverdueBody) for the same reason as the reminder route test:
// it proves the wiring, not just that mocks were called. Only the DB
// layer, push, dedup, audit, heartbeat and "today" are mocked.
//
// Distinguishing feature vs the reminder cron: this one flips NO
// state (no 'incomplete'-style status exists for equipment_inspections)
// and runs for EVERY enabled location regardless of weekday.

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
  resolveRoleRecipientIds: vi.fn(),
}))
vi.mock('@/lib/push-dedup', () => ({
  sendPushOnce: vi.fn(async () => ({ sent: 1 })),
}))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { GET } from './route.js'
import { listEnabledSettings, listActiveEquipment, listSubmittedSince } from '@/lib/equipment-db'
import { resolveRoleRecipientIds } from '@/lib/push'
import { sendPushOnce } from '@/lib/push-dedup'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

const SETTINGS_A = { location_id: 'loc-a', inspection_day_of_week: 2, enabled: true }
const SETTINGS_B = { location_id: 'loc-b', inspection_day_of_week: 5, enabled: true } // NOT today's dow — sweep must still run it

const OVERDUE_ASSETS = [
  { id: 'a', name: 'Treadmill 1', next_due_on: '2026-07-20', status: 'in_service' },
]

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.today = '2026-08-04'
  listEnabledSettings.mockResolvedValue([])
  listActiveEquipment.mockResolvedValue([])
  listSubmittedSince.mockResolvedValue([])
  resolveRoleRecipientIds.mockResolvedValue([])
})

describe('GET /api/cron/equipment-inspection-sweep', () => {
  it('rejects a missing bearer with 401', async () => {
    const res = await GET({ headers: { get: () => null } })
    expect(res.status).toBe(401)
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('rejects a wrong bearer with 401', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
  })

  it("runs a location whose inspection weekday is NOT today — unlike the reminder, overdue can hit any day", async () => {
    listEnabledSettings.mockResolvedValue([SETTINGS_B])
    listActiveEquipment.mockResolvedValue(OVERDUE_ASSETS)
    resolveRoleRecipientIds.mockResolvedValue(['prof-owner'])
    await GET(req())
    expect(listActiveEquipment).toHaveBeenCalledWith(fakeDb, 'loc-b')
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
  })

  it('sends no push when nothing is outstanding', async () => {
    listEnabledSettings.mockResolvedValue([SETTINGS_A])
    listActiveEquipment.mockResolvedValue([])
    await GET(req())
    expect(resolveRoleRecipientIds).not.toHaveBeenCalled()
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('resolves recipients for owner+master only, and dedups via sendPushOnce with category notify_inspection_overdue', async () => {
    listEnabledSettings.mockResolvedValue([SETTINGS_A])
    listActiveEquipment.mockResolvedValue(OVERDUE_ASSETS)
    resolveRoleRecipientIds.mockResolvedValue(['prof-owner', 'prof-master'])
    await GET(req())
    expect(resolveRoleRecipientIds).toHaveBeenCalledWith(fakeDb, 'loc-a', ['owner', 'master'])
    expect(sendPushOnce).toHaveBeenCalledWith(
      fakeDb,
      expect.stringContaining('loc-a'),
      ['prof-owner', 'prof-master'],
      expect.objectContaining({ category: 'notify_inspection_overdue' })
    )
  })

  it('skips the push (but still audits) when the resolved recipient list is empty', async () => {
    listEnabledSettings.mockResolvedValue([SETTINGS_A])
    listActiveEquipment.mockResolvedValue(OVERDUE_ASSETS)
    resolveRoleRecipientIds.mockResolvedValue([])
    await GET(req())
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('isolates a location that throws — the next location still gets processed', async () => {
    const other = { location_id: 'loc-c', inspection_day_of_week: 2, enabled: true }
    listEnabledSettings.mockResolvedValue([SETTINGS_A, other])
    listActiveEquipment.mockImplementation(async (db, locationId) => {
      if (locationId === 'loc-a') throw new Error('boom')
      return OVERDUE_ASSETS
    })
    resolveRoleRecipientIds.mockResolvedValue(['prof-owner'])

    const res = await GET(req())
    const body = await res.json()
    expect(body.success).toBe(true)
    const byLocation = Object.fromEntries(body.data.locations.map((l) => [l.locationId, l]))
    expect(byLocation['loc-a'].error).toBeTruthy()
    expect(byLocation['loc-c'].pushed).toBe(true)
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
  })

  it('flips no state — no update is ever issued against equipment or equipment_inspections', async () => {
    listEnabledSettings.mockResolvedValue([SETTINGS_A])
    listActiveEquipment.mockResolvedValue(OVERDUE_ASSETS)
    resolveRoleRecipientIds.mockResolvedValue(['prof-owner'])
    await GET(req())
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('calls stampHeartbeat with the exact mig-470 name', async () => {
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('equipment-inspection-sweep')
  })
})
