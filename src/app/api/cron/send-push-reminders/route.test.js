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
let throwOnTables = []
const fakeDb = {
  from: (table) => {
    if (throwOnTables.includes(table)) throw new Error(`${table} is down`)
    return makeBuilder(table)
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/shift-reminders', () => ({ runShiftReminders: vi.fn() }))

const { GET } = await import('./route.js')
const { runShiftReminders } = await import('@/lib/shift-reminders')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError, logInfo } = await import('@/lib/log')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  throwOnTables = []
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

  // The heartbeat is stamped either way, so without a key in the response and
  // the tick log a shift arm that throws on EVERY tick would be invisible.
  it('a throwing shift arm is VISIBLE: shift_arm_failed is 1 in the response and in the tick log', async () => {
    runShiftReminders.mockRejectedValue(new Error('shift read failed: column does not exist'))
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, shift_arm_failed: 1, task_pushed: 0, booking_pushed: 0 })
    expect(logInfo).toHaveBeenCalledWith('cron-push-reminders', 'tick', expect.objectContaining({ shift_arm_failed: 1 }))
  })

  it('a healthy shift arm reports shift_arm_failed: 0', async () => {
    expect((await (await GET(req())).json()).shift_arm_failed).toBe(0)
  })

  it('the mirror: the task and booking arms failing does not stop the shift arm', async () => {
    throwOnTables = ['activities', 'bookings']
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(runShiftReminders).toHaveBeenCalledTimes(1)
    expect((await res.json())).toMatchObject({ ok: true, shift_pushed: 1, shift_arm_failed: 0 })
    expect(logError).toHaveBeenCalled() // the other arms' failures were logged, not swallowed
  })

  it('a quiet-hours tick (nothing but quiet_hours: 1) does not write a tick log line 108 times a night', async () => {
    runShiftReminders.mockResolvedValue({ quiet_hours: 1, shift_candidates: 0, shift_pushed: 0 })
    const body = await (await GET(req())).json()
    expect(body.quiet_hours).toBe(1)
    expect(logInfo).not.toHaveBeenCalled()
  })
})
