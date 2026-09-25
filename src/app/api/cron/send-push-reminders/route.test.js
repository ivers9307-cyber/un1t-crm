// SHIFTREMIND.1 — the shift arm's WIRING in the push-reminder cron. The rule
// itself is pinned in src/lib/shift-reminders.test.js; what is locked here is
// that the route calls it with the clock and the locations it already read,
// reports its counters, and survives it throwing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOCATIONS = [{ id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin', notification_config: null }]

let locationsError = null
function makeBuilder(table) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'order', 'range']) b[m] = () => b
  b.then = (resolve, reject) => Promise.resolve(
    table === 'locations'
      ? { data: locationsError ? null : LOCATIONS, error: locationsError }
      : { data: [], error: null },
  ).then(resolve, reject)
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
vi.mock('@/lib/block-edit-notify', () => ({ runShiftTimeChangeNotices: vi.fn() }))

const { GET } = await import('./route.js')
const { runShiftReminders } = await import('@/lib/shift-reminders')
const { runShiftTimeChangeNotices } = await import('@/lib/block-edit-notify')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError, logInfo, logWarn } = await import('@/lib/log')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
// HEARTBEAT.1 — the heartbeat rows this tick stamped, in call order.
const stampedNames = () => stampHeartbeat.mock.calls.map((c) => c[0])

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  throwOnTables = []
  locationsError = null
  stampHeartbeat.mockImplementation(async () => {})
  runShiftReminders.mockResolvedValue({
    shift_candidates: 2, shift_pushed: 1, shift_emailed: 0,
    shift_skipped_dup: 1, shift_skipped_no_recipient: 0, shift_send_failed: 0,
  })
  runShiftTimeChangeNotices.mockResolvedValue({ time_change_rows: 1, time_change_told: 1 })
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
    // BLOCKEDIT.1 — the time-change arm is quiet on the same ticks.
    runShiftTimeChangeNotices.mockResolvedValue({ time_change_quiet: 1, time_change_rows: 0 })
    const body = await (await GET(req())).json()
    expect(body.quiet_hours).toBe(1)
    expect(body.time_change_quiet).toBe(1)
    expect(logInfo).not.toHaveBeenCalled()
  })
})

// HEARTBEAT.1 — the shift arm has a heartbeat row of its own ('shift-reminders',
// mig 633). 'send-push-reminders' is stamped whatever the shift arm did and the
// health-check reads only is_stale, so an arm that threw on every tick paged
// nobody. The row is stamped ONLY when the arm returned a summary with no
// fault of its own (src/lib/cron-arm-health.js), with the arm's counters.
const CLEAN = {
  quiet_hours: 0, shift_candidates: 2, shift_pushed: 1, shift_emailed: 0, shift_skipped_dup: 1,
  shift_skipped_no_recipient: 0, shift_send_failed: 0, shift_send_threw: 0, shift_claim_failed: 0, shift_read_capped: 0,
}

describe('GET /api/cron/send-push-reminders — shift-reminders heartbeat', () => {
  // The parent's stamp is unchanged by HEARTBEAT.1: once per tick, no outcome.
  const expectParentStampUnchanged = () =>
    expect(stampHeartbeat.mock.calls.filter((c) => c[0] === 'send-push-reminders')).toEqual([['send-push-reminders']])

  it('a clean arm: shift-reminders is stamped with the arm\'s own counters, then send-push-reminders as before', async () => {
    runShiftReminders.mockResolvedValue(CLEAN)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['shift-reminders', 'shift-time-changes', 'send-push-reminders'])
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', CLEAN)
    expectParentStampUnchanged()
  })

  it('a tick with nothing to send stamps: a quiet day is healthy', async () => {
    const idle = { ...CLEAN, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 }
    runShiftReminders.mockResolvedValue(idle)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', idle)
  })

  it('a quiet-hours tick stamps, so the row cannot go stale overnight', async () => {
    const quiet = { ...CLEAN, quiet_hours: 1, shift_candidates: 0, shift_pushed: 0, shift_skipped_dup: 0 }
    runShiftReminders.mockResolvedValue(quiet)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', quiet)
  })

  it('a failed delivery (claim released, retried next tick) still stamps, and the count reaches last_outcome', async () => {
    runShiftReminders.mockResolvedValue({ ...CLEAN, shift_send_failed: 1 })
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-reminders', expect.objectContaining({ shift_send_failed: 1 }))
  })

  it('the arm THROWS: shift-reminders is NOT stamped; the parent is, unchanged, and the tick is still a 200', async () => {
    runShiftReminders.mockRejectedValue(new Error('shift read failed: column does not exist'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, shift_arm_failed: 1 })
    expect(stampedNames()).toEqual(['shift-time-changes', 'send-push-reminders'])
    expectParentStampUnchanged()
  })

  it.each(['shift_claim_failed', 'shift_send_threw', 'shift_read_capped'])('the arm reports %s: shift-reminders NOT stamped, parent unchanged', async (key) => {
    runShiftReminders.mockResolvedValue({ ...CLEAN, [key]: 1 })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['shift-time-changes', 'send-push-reminders'])
    expectParentStampUnchanged()
  })

  it('an arm that resolves with nothing has not shown it ran: not stamped', async () => {
    runShiftReminders.mockResolvedValue(undefined)
    await GET(req())
    expect(stampedNames()).toEqual(['shift-time-changes', 'send-push-reminders'])
  })

  it('a failed locations read is a 500 that stamps NEITHER row (unchanged: the arm never ran)', async () => {
    locationsError = { message: 'locations down' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(runShiftReminders).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a rejecting shift-reminders stamp cannot cost the parent its stamp or its 200', async () => {
    runShiftReminders.mockResolvedValue(CLEAN)
    stampHeartbeat.mockImplementation((name) =>
      name === 'shift-reminders' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['shift-reminders', 'shift-time-changes', 'send-push-reminders'])
    expect(logWarn).toHaveBeenCalledWith('cron-push-reminders', 'shift-reminders heartbeat failed', expect.anything())
  })
})

// BLOCKEDIT.1 — the time-change notice arm: the later tick that lets quiet
// hours gate a shift-edit notice without losing it.
describe('GET /api/cron/send-push-reminders — time-change arm', () => {
  it('runs with the tick clock and the location rows, and reports its counters', async () => {
    const before = Date.now()
    const body = await (await GET(req())).json()
    expect(runShiftTimeChangeNotices).toHaveBeenCalledTimes(1)
    const [db, opts] = runShiftTimeChangeNotices.mock.calls[0]
    expect(db).toBe(fakeDb)
    expect(opts.locations).toEqual(LOCATIONS)
    expect(opts.nowMs).toBeGreaterThanOrEqual(before)
    expect(body.time_change_told).toBe(1)
  })

  it('a throwing arm is visible in the response, costs the shift arm nothing, and the heartbeat still stamps', async () => {
    runShiftTimeChangeNotices.mockRejectedValue(new Error('select 400'))
    const body = await (await GET(req())).json()
    expect(body.time_change_arm_failed).toBe(1)
    expect(runShiftReminders).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('send-push-reminders')
    expect(logError).toHaveBeenCalledWith('cron-push-reminders', 'time-change block threw', expect.anything())
  })

  it('a throwing SHIFT arm still lets the time-change arm run', async () => {
    runShiftReminders.mockRejectedValue(new Error('boom'))
    await GET(req())
    expect(runShiftTimeChangeNotices).toHaveBeenCalledTimes(1)
  })
})

// BLOCKEDIT.1 review — the time-change arm's OWN heartbeat row
// ('shift-time-changes', mig 639), the CLAUDE.md arm rule: stamped only on a
// clean run (quiet ticks included), never on a throw or an arm fault, under
// its own catch, and it can never cost the parent its stamp.
describe('GET /api/cron/send-push-reminders — shift-time-changes heartbeat', () => {
  const TC_CLEAN = {
    time_change_quiet: 0, time_change_rows: 1, time_change_told: 1, time_change_not_needed: 0,
    time_change_deduped: 0, time_change_undelivered: 0, time_change_send_failed: 0,
    time_change_stamp_failed: 0, time_change_told_stamp_failed: 0, time_change_read_failed: 0, time_change_read_capped: 0,
  }

  it("a clean run stamps shift-time-changes with the arm's counters, after shift-reminders and before the parent", async () => {
    runShiftTimeChangeNotices.mockResolvedValue(TC_CLEAN)
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('shift-time-changes', TC_CLEAN)
    expect(stampedNames().at(-1)).toBe('send-push-reminders')
  })

  it('a quiet-hours tick stamps, so the row cannot go stale overnight', async () => {
    runShiftTimeChangeNotices.mockResolvedValue({ ...TC_CLEAN, time_change_quiet: 1, time_change_rows: 0, time_change_told: 0 })
    await GET(req())
    expect(stampedNames()).toContain('shift-time-changes')
  })

  it('a failed delivery is not an arm fault: still stamps', async () => {
    runShiftTimeChangeNotices.mockResolvedValue({ ...TC_CLEAN, time_change_send_failed: 1 })
    await GET(req())
    expect(stampedNames()).toContain('shift-time-changes')
  })

  it.each(['time_change_read_failed', 'time_change_read_capped', 'time_change_stamp_failed'])('%s: NOT stamped, parent still is', async (key) => {
    runShiftTimeChangeNotices.mockResolvedValue({ ...TC_CLEAN, [key]: 1 })
    await GET(req())
    expect(stampedNames()).not.toContain('shift-time-changes')
    expect(stampedNames()).toContain('send-push-reminders')
  })

  it('the arm THROWS: NOT stamped; the parent is, and the tick is a 200', async () => {
    runShiftTimeChangeNotices.mockRejectedValue(new Error('select 400'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).not.toContain('shift-time-changes')
    expect(stampedNames()).toContain('send-push-reminders')
  })

  it('a rejecting shift-time-changes stamp cannot cost the parent its stamp or its 200', async () => {
    runShiftTimeChangeNotices.mockResolvedValue(TC_CLEAN)
    stampHeartbeat.mockImplementation((name) =>
      name === 'shift-time-changes' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toContain('send-push-reminders')
    expect(logWarn).toHaveBeenCalledWith('cron-push-reminders', 'shift-time-changes heartbeat failed', expect.anything())
  })
})

