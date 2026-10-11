// TZ.6 — contract-reminders runs hourly. A contract's location acts at its
// daily slot (08:00 UTC for Europe/Dublin, as before; 08:00 local elsewhere),
// once per local day. The runway and qualification arms keep the 08:00 UTC tick.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let contractRows = []
const claims = new Map()
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/contracts', () => ({ reminderDue: vi.fn(() => true) }))
vi.mock('@/lib/contracts-email', () => ({ sendContractReminderEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/roster-runway-notify', () => ({ runRosterRunwayAlerts: vi.fn(async () => ({ locations: 0 })) }))
vi.mock('@/lib/qualification-digest', () => ({ runQualificationDigest: vi.fn(async () => ({ organizations: 0 })) }))
vi.mock('@/lib/supabase', async () => {
  const { withSlotTables } = await import('@/lib/cron-daily-slot.test-helpers')
  function builder() {
    const st = {}
    const b = {}
    for (const m of ['in', 'lt', 'order', 'range', 'eq', 'select']) b[m] = () => b
    b.update = (patch) => { st.patch = patch; return b }
    b.then = (res, rej) => Promise.resolve(st.patch ? { data: null, error: null } : { data: contractRows, error: null }).then(res, rej)
    return b
  }
  const locations = [{ id: 'loc-dub', timezone: 'Europe/Dublin' }, { id: 'loc-ny', timezone: 'America/New_York' }]
  return { createServerClient: () => withSlotTables({ from: builder }, { locations, claims }) }
})

const { GET } = await import('./route.js')
const { sendContractReminderEmail } = await import('@/lib/contracts-email')
const { runRosterRunwayAlerts } = await import('@/lib/roster-runway-notify')
const { runQualificationDigest } = await import('@/lib/qualification-digest')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const K = (id, location_id) => ({ id, status: 'issued', issued_at: '2026-06-20T09:00:00Z', reminder_count: 0, location_id, profile: { id: 'p1', full_name: 'Test Coach', email: 'coach@example.test' }, template: { name: 'Agreement' } })
const at = async (iso) => { vi.setSystemTime(Date.parse(iso)); return (await GET(req())).json() }
const reminded = () => sendContractReminderEmail.mock.calls.map(([a]) => a.contract.id)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'test-secret'
  claims.clear()
  contractRows = [K('k-dub', 'loc-dub'), K('k-ny', 'loc-ny')]
})

describe('TZ.6 contract-reminders', () => {
  it('Europe/Dublin reminds at 08:00 UTC, not at 07:00 UTC (08:00 IST); every tick stamps', async () => {
    await at('2026-07-01T07:00:00Z')
    expect(reminded()).toEqual([])
    await at('2026-07-01T08:00:00Z')
    expect(reminded()).toEqual(['k-dub'])
    expect(stampHeartbeat.mock.calls.filter(([n]) => n === 'contract-reminders')).toHaveLength(2)
  })

  it('America/New_York reminds at 08:00 local (12:00Z in summer), once that day', async () => {
    await at('2026-07-01T12:00:00Z')
    await at('2026-07-01T13:00:00Z')
    expect(reminded()).toEqual(['k-ny'])
  })

  it('the arms run only on the 08:00 UTC tick, as on the old daily schedule', async () => {
    await at('2026-07-01T07:00:00Z')
    await at('2026-07-01T12:00:00Z')
    expect(runRosterRunwayAlerts).not.toHaveBeenCalled()
    expect(runQualificationDigest).not.toHaveBeenCalled()
    await at('2026-07-01T08:00:00Z')
    expect(runRosterRunwayAlerts).toHaveBeenCalledTimes(1)
    expect(runQualificationDigest).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).not.toContain(undefined)
  })
})
