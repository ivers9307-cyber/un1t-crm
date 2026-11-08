// TZ.6 — event-reminders runs hourly; each event location acts at its daily
// slot (09:00 UTC for Europe/Dublin, as before; 09:00 local elsewhere).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const claims = new Map()
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/event-attendee-reminders', () => ({ runEventReminders: vi.fn(async () => ({ events: 1, sent: 1, skipped: 0 })) }))
// HOSTPAGE.2 — the rating-request arm has its own tests; here it is a stub.
vi.mock('@/lib/event-rating-requests', () => ({ runRatingRequests: vi.fn(async () => ({ events: 0, sent: 0, skipped: 0, request_read_failed: 0, claim_failed: 0 })) }))
vi.mock('@/lib/supabase', async () => {
  const { withSlotTables } = await import('@/lib/cron-daily-slot.test-helpers')
  const locations = [{ id: 'loc-dub', timezone: 'Europe/Dublin' }, { id: 'loc-ny', timezone: 'America/New_York' }]
  return { createServerClient: () => withSlotTables({ from: () => { throw new Error('unexpected read') } }, { locations, claims }) }
})

const { GET } = await import('./route')
const { runEventReminders } = await import('@/lib/event-attendee-reminders')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { runRatingRequests } = await import('@/lib/event-rating-requests')
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
    // HOSTPAGE.2 — the slot tick stamps the parent AND the rating-request arm's own row.
    expect(stampHeartbeat.mock.calls.map(([n]) => n).sort()).toEqual(['event-rating-requests', 'event-reminders'])
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

// HOSTPAGE.2 — the rating-request arm rides this cron on its own 09:00 slot
// and its own heartbeat row; the parent's stamp and status never depend on it.
describe('rating-request arm (HOSTPAGE.2)', () => {
  it('runs on the slot tick with the slot\'s isDue and stamps its own row on a clean outcome', async () => {
    const body = await at('2026-07-01T09:00:00Z')
    expect(runRatingRequests).toHaveBeenCalledTimes(1)
    const args = runRatingRequests.mock.calls[0][0]
    expect(args.isDue('loc-dub')).toBe(true)
    expect(args.isDue('loc-ny')).toBe(false)
    expect(stampHeartbeat.mock.calls.map(([n]) => n).sort()).toEqual(['event-rating-requests', 'event-reminders'])
    expect(body.data.rating_requests).toMatchObject({ sent: 0 })
  })
  it('a quiet tick runs neither arm', async () => {
    await at('2026-07-01T08:00:00Z')
    expect(runRatingRequests).not.toHaveBeenCalled()
  })
  it('a faulted outcome (claim_failed) or a throw leaves the arm row unstamped and the parent untouched', async () => {
    runRatingRequests.mockResolvedValueOnce({ events: 1, sent: 0, skipped: 1, request_read_failed: 0, claim_failed: 1 })
    let body = await at('2026-07-01T09:00:00Z')
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['event-reminders'])
    expect(body.success).toBe(true)
    vi.clearAllMocks(); claims.clear()
    runRatingRequests.mockRejectedValueOnce(new Error('arm down'))
    body = await at('2026-07-02T09:00:00Z')
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['event-reminders'])
    expect(body.success).toBe(true)
    expect(body.data.rating_requests).toEqual({ ok: false, error: 'arm down' })
  })
})

describe('rating-request arm — independent gate (HOSTPAGE.2 review)', () => {
  it('runs on a tick where the parent already took its slot but the arm\'s own claim is still open', async () => {
    await at('2026-07-01T09:00:00Z') // both claim
    expect(runRatingRequests).toHaveBeenCalledTimes(1)
    for (const k of [...claims.keys()]) if (k.startsWith('event-rating-requests|')) claims.delete(k)
    vi.clearAllMocks()
    const body = await at('2026-07-01T09:00:00Z') // the parent's claim is held: a quiet tick for it
    expect(runEventReminders).not.toHaveBeenCalled()
    expect(runRatingRequests).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls.map(([n]) => n)).toEqual(['event-rating-requests'])
    expect(body.data.rating_requests).toMatchObject({ ok: true })
  })
})
