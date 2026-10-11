// TZ.6 — event-reminders runs hourly; each event location acts at its daily
// slot (09:00 UTC for Europe/Dublin, as before; 09:00 local elsewhere).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const claims = new Map()
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/event-attendee-reminders', () => ({ runEventReminders: vi.fn(async () => ({ events: 1, sent: 1, skipped: 0 })) }))
vi.mock('@/lib/supabase', async () => {
  const { withSlotTables } = await import('@/lib/cron-daily-slot.test-helpers')
  const locations = [{ id: 'loc-dub', timezone: 'Europe/Dublin' }, { id: 'loc-ny', timezone: 'America/New_York' }]
  return { createServerClient: () => withSlotTables({ from: () => { throw new Error('unexpected read') } }, { locations, claims }) }
})

const { GET } = await import('./route')
const { runEventReminders } = await import('@/lib/event-attendee-reminders')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const req = () => new Request('https://x.test/api/cron/event-reminders', { headers: { authorization: 'Bearer shh' } })
const at = async (iso) => { vi.setSystemTime(Date.parse(iso)); return (await GET(req())).json() }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'shh'
  claims.clear()
})

describe('TZ.6 event-reminders', () => {
  it('Europe/Dublin runs at 09:00 UTC only; a quiet tick never stamps, the slot tick does', async () => {
    await at('2026-07-01T08:00:00Z')
    expect(runEventReminders).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    await at('2026-07-01T09:00:00Z')
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    const args = runEventReminders.mock.calls[0][0]
    expect(args.nowMs).toBe(Date.parse('2026-07-01T09:00:00Z'))
    expect(args.isDue('loc-dub')).toBe(true)
    expect(args.isDue(null)).toBe(true) // an event with no location: DEFAULT_TZ
    expect(args.isDue('loc-ny')).toBe(false) // 05:00 in New York: not its slot
  })

  it('America/New_York runs at 09:00 local (13:00Z in summer), once per local day', async () => {
    await at('2026-07-01T13:00:00Z')
    await at('2026-07-01T14:00:00Z')
    expect(runEventReminders).toHaveBeenCalledTimes(1)
    const args = runEventReminders.mock.calls[0][0]
    expect(args.isDue('loc-ny')).toBe(true)
    expect(args.isDue('loc-dub')).toBe(false)
  })
})
