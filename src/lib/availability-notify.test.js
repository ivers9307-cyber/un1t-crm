// AVAIL.1 — the managers' notice. One push per save to the roster builders at
// every studio the coach belongs to, inside 07:00-22:00 studio time, deduped
// by change id; outside the band it waits for the sweep. Instants are UTC with
// the Dublin wall clock in the test name (BST on these dates: UTC+1).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push-dedup', () => ({ sendPushOnce: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { sendPushOnce } = await import('@/lib/push-dedup')
const { logError } = await import('@/lib/log')
const {
  AVAILABILITY_NOTIFY_ROLES, AVAILABILITY_NOTICE_MAX_AGE_MS, availabilityEventKey, availabilityNoticeText,
  splitStudiosByBand, deliverAvailabilityNotice, runAvailabilityNoticeSweep,
} = await import('./availability-notify')
const { RUNWAY_NOTIFY_ROLES } = await import('./roster-runway-notify')

const COACH = 'coach-1'
const LOC_A = 'loc-a'
const LOC_B = 'loc-b'
const NOON = Date.parse('2026-09-25T11:00:00Z')      // 12:00 Dublin
const LATE = Date.parse('2026-09-25T22:30:00Z')      // 23:30 Dublin
const MON = { kind: 'weekly', weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null }
const TUE = { kind: 'weekly', weekday: 'tue', all_day: true, start_time: null, end_time: null, note: null }

function change(over = {}) {
  return { id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: '2026-09-25T10:59:00Z', ...over }
}

// Recording fake; handlers[table](call) answers each awaited chain.
function fakeDb(handlers) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, ops: [] }
      calls.push(call)
      const b = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'maybeSingle']) {
        b[m] = (...args) => { call.ops.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve().then(() => handlers[table](call)).then(resolve, reject)
      return b
    },
  }
}
const has = (call, name) => call.ops.some((o) => o[0] === name)
const stamps = (db) => db.calls.filter((c) => c.table === 'staff_availability_changes' && has(c, 'update'))

// profile_locations answers two different reads: the coach's studios (.eq)
// and the recipients at those studios (.in). Fictional people only.
function world({ coachStudios = [LOC_A, LOC_B], tz = 'Europe/Dublin', members, linkError = null, stampError = null, queue = [], queueError = null } = {}) {
  const roster = members || [
    { profile_id: 'mgr-a', location_id: LOC_A, role: 'manager', profiles: { id: 'mgr-a', role: 'staff', active: true } },
    { profile_id: 'hc-b', location_id: LOC_B, role: 'head_coach', profiles: { id: 'hc-b', role: 'staff', active: true } },
    { profile_id: 'own', location_id: LOC_A, role: 'owner', profiles: { id: 'own', role: 'staff', active: true } },
    { profile_id: 'own', location_id: LOC_B, role: 'owner', profiles: { id: 'own', role: 'staff', active: true } },
    { profile_id: 'staff-a', location_id: LOC_A, role: 'staff', profiles: { id: 'staff-a', role: 'staff', active: true } },
    { profile_id: 'gone-mgr', location_id: LOC_A, role: 'manager', profiles: { id: 'gone-mgr', role: 'staff', active: false } },
    { profile_id: 'master', location_id: LOC_B, role: 'staff', profiles: { id: 'master', role: 'master', active: true } },
    { profile_id: COACH, location_id: LOC_A, role: 'head_coach', profiles: { id: COACH, role: 'staff', active: true } },
  ]
  return fakeDb({
    profile_locations: (call) => {
      if (has(call, 'eq')) {
        if (linkError) return { data: null, error: linkError }
        return { data: coachStudios.map((id) => ({ location_id: id, locations: { id, timezone: tz } })), error: null }
      }
      return { data: roster, error: null }
    },
    profiles: () => ({ data: { full_name: 'Sam Demo' }, error: null }),
    staff_availability_changes: (call) => (has(call, 'update')
      ? { data: null, error: stampError }
      : { data: queueError ? null : queue, error: queueError }),
  })
}

beforeEach(() => {
  sendPushOnce.mockReset()
  sendPushOnce.mockResolvedValue({ sent: 3, skipped: 0, invalidated: 0, failed: 0, deduped: 0 })
  logError.mockReset()
})

describe('constants and text', () => {
  it("tells the roster builders: the runway alert's roles", () => {
    expect(AVAILABILITY_NOTIFY_ROLES).toEqual(RUNWAY_NOTIFY_ROLES)
    expect(AVAILABILITY_NOTICE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
    expect(availabilityEventKey('x')).toBe('availability_changed:x')
  })
  it('says what was added and removed', () => {
    expect(availabilityNoticeText({ coachName: 'Sam Demo', before: [MON], after: [TUE] })).toEqual({
      title: 'Availability changed',
      body: 'Sam Demo is now unavailable Tuesdays, all day; available again Mondays, 9am–12pm.',
    })
  })
  it('caps a long list, and says a note-only change for what it is', () => {
    const many = ['mon', 'tue', 'wed', 'thu', 'fri'].map((weekday) => ({ ...TUE, weekday }))
    expect(availabilityNoticeText({ coachName: 'Sam Demo', before: [], after: many }).body)
      .toBe('Sam Demo is now unavailable Mondays, all day, Tuesdays, all day, Wednesdays, all day and 2 more.')
    expect(availabilityNoticeText({ coachName: ' ', before: [MON], after: [{ ...MON, note: 'x' }] }).body)
      .toBe('A coach updated the notes on their availability.')
  })
  it("splits studios by the 07:00-22:00 band at each studio's own clock", () => {
    const split = splitStudiosByBand([{ id: LOC_A, timezone: 'Europe/Dublin' }, { id: LOC_B, timezone: 'America/New_York' }], LATE)
    expect(split.inBand.map((s) => s.id)).toEqual([LOC_B]) // 18:30 in New York
    expect(split.quiet.map((s) => s.id)).toEqual([LOC_A])
  })
})

describe('deliverAvailabilityNotice', () => {
  it('in band: ONE deduped push to the roster builders and masters at both studios, never the coach, then stamped sent', async () => {
    const db = world()
    const out = await deliverAvailabilityNotice(db, change(), { nowMs: NOON })
    expect(out).toEqual({ status: 'sent', sent: 3 })
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
    const [, key, ids, payload] = sendPushOnce.mock.calls[0]
    expect(key).toBe('availability_changed:ch-1')
    expect([...ids].sort()).toEqual(['hc-b', 'master', 'mgr-a', 'own'])
    expect(payload).toMatchObject({
      title: 'Availability changed',
      category: 'availability_change',
      data: { type: 'availability_changed', profile_id: COACH, change_id: 'ch-1' },
    })
    const [stamp] = stamps(db)
    expect(stamp.ops).toContainEqual(['update', { notified_at: new Date(NOON).toISOString(), notice_outcome: 'sent' }])
    expect(stamp.ops).toContainEqual(['in', 'id', ['ch-1']])
    expect(stamp.ops).toContainEqual(['is', 'notified_at', null])
  })

  it("a manager whose active is NULL still counts (mig 626's `active IS NOT FALSE`)", async () => {
    const db = world({
      members: [
        { profile_id: 'mgr-null', location_id: LOC_A, role: 'manager', profiles: { id: 'mgr-null', role: 'staff', active: null } },
        { profile_id: 'mgr-off', location_id: LOC_A, role: 'manager', profiles: { id: 'mgr-off', role: 'staff', active: false } },
      ],
    })
    await deliverAvailabilityNotice(db, change(), { nowMs: NOON })
    expect(sendPushOnce.mock.calls[0][2]).toEqual(['mgr-null'])
  })

  it('outside the band: nothing sent, nothing stamped (the sweep sends it at 07:00)', async () => {
    const db = world()
    expect(await deliverAvailabilityNotice(db, change({ created_at: '2026-09-25T22:29:00Z' }), { nowMs: LATE })).toEqual({ status: 'deferred', sent: 0 })
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)).toHaveLength(0)
  })

  it('a coach with no studio: stamped no_recipients, no push', async () => {
    const db = world({ coachStudios: [] })
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('no_recipients')
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)[0].ops).toContainEqual(['update', { notified_at: new Date(NOON).toISOString(), notice_outcome: 'no_recipients' }])
  })

  it('an unreadable membership is an error: no push, no stamp (a later tick retries)', async () => {
    const db = world({ linkError: { message: 'down' } })
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('error')
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)).toHaveLength(0)
    expect(logError).toHaveBeenCalled()
  })

  it('a push that failed outright is retried later, not stamped', async () => {
    sendPushOnce.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 2, deduped: 0 })
    const db = world()
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('deferred')
    expect(stamps(db)).toHaveLength(0)
  })

  it('older than 24 hours: stamped stale, never sent', async () => {
    const db = world()
    const old = change({ created_at: new Date(NOON - AVAILABILITY_NOTICE_MAX_AGE_MS - 1).toISOString() })
    expect((await deliverAvailabilityNotice(db, old, { nowMs: NOON })).status).toBe('stale')
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('a later save that undid it: stamped reverted, never sent', async () => {
    const db = world()
    expect((await deliverAvailabilityNotice(db, change({ after: [MON] }), { nowMs: NOON })).status).toBe('reverted')
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('a failed stamp is reported as an error, after the push went (the ledger stops a double)', async () => {
    const db = world({ stampError: { message: 'down' } })
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('error')
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
  })
})

describe('runAvailabilityNoticeSweep', () => {
  it("folds one coach's overnight saves into ONE notice: oldest before, newest after, newest id, every row stamped", async () => {
    const db = world({
      queue: [
        { id: 'ch-1', profile_id: COACH, before: [MON], after: [], created_at: '2026-09-24T22:10:00Z' },
        { id: 'ch-2', profile_id: COACH, before: [], after: [TUE], created_at: '2026-09-24T22:40:00Z' },
      ],
    })
    const out = await runAvailabilityNoticeSweep(db, { nowMs: Date.parse('2026-09-25T06:05:00Z') }) // 07:05 Dublin
    expect(out).toMatchObject({ pending: 2, groups: 1, sent: 1, errors: 0 })
    const [, key, , payload] = sendPushOnce.mock.calls[0]
    expect(key).toBe('availability_changed:ch-2')
    expect(payload.body).toBe('Sam Demo is now unavailable Tuesdays, all day; available again Mondays, 9am–12pm.')
    expect(stamps(db)[0].ops).toContainEqual(['in', 'id', ['ch-1', 'ch-2']])
  })

  it('reads only un-notified rows, oldest first, capped', async () => {
    const db = world()
    await runAvailabilityNoticeSweep(db, { nowMs: NOON })
    const read = db.calls.find((c) => c.table === 'staff_availability_changes')
    expect(read.ops).toContainEqual(['is', 'notified_at', null])
    expect(read.ops).toContainEqual(['order', 'created_at', { ascending: true }])
    expect(read.ops).toContainEqual(['limit', 200])
  })

  it('a quiet tick defers without errors (so the heartbeat stamps overnight)', async () => {
    const db = world({ queue: [{ id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: '2026-09-25T22:00:00Z' }] })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: LATE })).toMatchObject({ deferred: 1, errors: 0 })
  })

  it('an unreadable queue is one error, never "nothing owed"', async () => {
    const db = world({ queueError: { message: 'down' } })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: NOON })).toMatchObject({ errors: 1, pending: 0 })
  })
})
