// TZ.6 — the two equipment crons run hourly. Each location acts at its daily
// slot (reminder 06:00, sweep 19:00: UTC for Europe/Dublin, as before; local
// elsewhere), once per local day, with "today" its own calendar day.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const claims = new Map()
vi.mock('@/lib/equipment-db', () => ({
  listEnabledSettings: vi.fn(async () => [
    { location_id: 'loc-dub', inspection_day_of_week: 3, enabled: true },
    { location_id: 'loc-ny', inspection_day_of_week: 3, enabled: true },
  ]),
  listActiveEquipment: vi.fn(async () => [{ id: 'a', name: 'Rower', next_due_on: '2026-07-01', status: 'in_service' }]),
  listSubmittedSince: vi.fn(async () => []),
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn(async () => ({ sent: 1 })),
  readRoleRecipientIds: vi.fn(async () => ({ ids: ['p1'], error: null })),
}))
vi.mock('@/lib/push-dedup', () => ({ sendPushOnce: vi.fn(async () => ({ sent: 1, failed: 0 })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/supabase', async () => {
  const { withSlotTables } = await import('@/lib/cron-daily-slot.test-helpers')
  const locations = [{ id: 'loc-dub', timezone: 'Europe/Dublin' }, { id: 'loc-ny', timezone: 'America/New_York' }]
  return { createServerClient: () => withSlotTables({ from: () => { throw new Error('unexpected read') } }, { locations, claims }) }
})

const reminder = await import('./route.js')
const sweep = await import('../equipment-inspection-sweep/route.js')
const { sendPushToRolesAtLocation } = await import('@/lib/push')
const { sendPushOnce } = await import('@/lib/push-dedup')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const at = async (route, iso) => { vi.setSystemTime(Date.parse(iso)); return (await route.GET(req())).json() }
const reminded = () => sendPushToRolesAtLocation.mock.calls.map(([loc]) => loc)
const chased = () => sendPushOnce.mock.calls.map(([, key]) => key)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'test-secret'
  claims.clear()
})

describe('TZ.6 equipment-inspection-reminder (Wednesday 1 Jul 2026)', () => {
  it('Europe/Dublin at 06:00 UTC only; New York at 06:00 local (10:00Z); only the two slot ticks stamp', async () => {
    await at(reminder, '2026-07-01T05:00:00Z')
    await at(reminder, '2026-07-01T06:00:00Z')
    await at(reminder, '2026-07-01T07:00:00Z')
    expect(reminded()).toEqual(['loc-dub'])
    await at(reminder, '2026-07-01T10:00:00Z')
    expect(reminded()).toEqual(['loc-dub', 'loc-ny'])
    expect(stampHeartbeat).toHaveBeenCalledTimes(2)
  })

  it("New York's inspection weekday is its own: 06:00 Wednesday local is 10:00Z Wednesday", async () => {
    const out = await at(reminder, '2026-07-01T10:00:00Z')
    expect(out.data.locations).toEqual([{ locationId: 'loc-ny', due: 1, pushed: true }])
  })
})

describe('TZ.6 equipment-inspection-sweep', () => {
  it('Europe/Dublin chases at 19:00 UTC, New York at 19:00 local (23:00Z), each keyed on its own day', async () => {
    await at(sweep, '2026-07-01T18:00:00Z')
    await at(sweep, '2026-07-01T19:00:00Z')
    await at(sweep, '2026-07-01T23:00:00Z')
    await at(sweep, '2026-07-02T00:00:00Z')
    expect(chased()).toEqual(['equip-overdue:loc-dub:2026-07-01', 'equip-overdue:loc-ny:2026-07-01'])
  })
})
