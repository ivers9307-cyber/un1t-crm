// SHIFTREMIND.1 — the shift arm's WIRING in the push-reminder cron. The rule
// itself is pinned in src/lib/shift-reminders.test.js; what is locked here is
// that the route calls it with the clock and the locations it already read,
// reports its counters, and survives it throwing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOCATIONS = [{ id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin', notification_config: null }]

function makeBuilder(table) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'order', 'range']) b[m] = () => b
  b.then = (resolve, reject) =>
    Promise.resolve({ data: table === 'locations' ? LOCATIONS : [], error: null }).then(resolve, reject)
  return b
}
const fakeDb = { from: (table) => makeBuilder(table) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/shift-reminders', () => ({ runShiftReminders: vi.fn() }))

const { GET } = await import('./route.js')
const { runShiftReminders } = await import('@/lib/shift-reminders')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  runShiftReminders.mockResolvedValue({
    shift_candidates: 2, shift_pushed: 1, shift_emailed: 0,
    shift_skipped_dup: 1, shift_skipped_no_recipient: 0, shift_send_failed: 0,
  })
})

describe('GET /api/cron/send-push-reminders — shift arm', () => {
  it('401 without the cron bearer, and the shift arm never runs', async () => {
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(runShiftReminders).not.toHaveBeenCalled()
  })

  it('runs the shift arm with the tick clock and the location rows (name + timezone included)', async () => {
    const before = Date.now()
    await GET(req())
    expect(runShiftReminders).toHaveBeenCalledTimes(1)
    const [db, opts] = runShiftReminders.mock.calls[0]
    expect(db).toBe(fakeDb)
    expect(opts.locations).toEqual(LOCATIONS)
    expect(opts.nowMs).toBeGreaterThanOrEqual(before)
    expect(opts.nowMs).toBeLessThanOrEqual(Date.now())
  })

  it('reports the shift counters beside the task and booking ones', async () => {
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, task_pushed: 0, booking_pushed: 0, shift_candidates: 2, shift_pushed: 1, shift_skipped_dup: 1 })
  })

  it('a throwing shift arm is logged and costs nothing else: 200, heartbeat stamped', async () => {
    runShiftReminders.mockRejectedValue(new Error('reminder ledger read failed: boom'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(logError).toHaveBeenCalledWith('cron-push-reminders', 'shift block threw', expect.anything())
    expect(stampHeartbeat).toHaveBeenCalledWith('send-push-reminders')
  })
})
