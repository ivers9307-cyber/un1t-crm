// AVAIL.1 — the managers' notice. One push per save to the roster builders at
// every studio the coach belongs to, inside 07:00-22:00 studio time, deduped
// by change id; outside the band it waits for the sweep. Instants are UTC with
// the Dublin wall clock in the test name (BST on these dates: UTC+1).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push-dedup', () => ({ sendPushOnce: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { sendPushOnce } = await import('@/lib/push-dedup')
const { logError, logWarn } = await import('@/lib/log')
const {
  AVAILABILITY_NOTIFY_ROLES, AVAILABILITY_NOTICE_MAX_AGE_MS, AVAILABILITY_NOTICE_LEASE_MS, AVAILABILITY_RETRY_SLOT_MS, AVAILABILITY_MAX_RETRIES,
  availabilityEventKey, availabilityRetryKey, availabilityNoticeText,
  splitStudiosByBand, deliverAvailabilityNotice, deliverOwedAvailabilityNotices, runAvailabilityNoticeSweep,
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
      for (const m of ['select', 'eq', 'in', 'is', 'like', 'order', 'limit', 'update', 'maybeSingle']) {
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
function world({ coachStudios = [LOC_A, LOC_B], tz = 'Europe/Dublin', members, linkError = null, stampError = null, queue = [], queueError = null, claims = [], claimsError = null } = {}) {
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
    push_event_sends: () => (claimsError ? { data: null, error: claimsError } : { data: claims, error: null }),
    staff_availability_changes: (call) => (has(call, 'update')
      ? { data: null, error: stampError }
      : { data: queueError ? null : (typeof queue === 'function' ? queue(call) : queue), error: queueError }),
  })
}

beforeEach(() => {
  sendPushOnce.mockReset()
  sendPushOnce.mockResolvedValue({ sent: 3, skipped: 0, invalidated: 0, failed: 0, deduped: 0 })
  logError.mockReset()
  logWarn.mockReset()
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

  it('View as user: the master who made the change is not told about it', async () => {
    const db = world()
    await deliverAvailabilityNotice(db, change({ actor_id: 'master' }), { nowMs: NOON })
    expect([...sendPushOnce.mock.calls[0][2]].sort()).toEqual(['hc-b', 'mgr-a', 'own'])
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

  it('a FULLY deduped attempt (another attempt holds every claim) does not stamp: the claim-holder stamps, or a later slot retries', async () => {
    sendPushOnce.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 4 })
    const db = world()
    expect(await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).toEqual({ status: 'deferred', sent: 0 })
    expect(stamps(db)).toHaveLength(0)
  })

  it('recipients with no device (nothing sent, nothing deduped) still settle: there is nothing to retry', async () => {
    sendPushOnce.mockResolvedValueOnce({ sent: 0, skipped: 4, invalidated: 0, failed: 0, deduped: 0 })
    const db = world()
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('sent')
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

// The save's own attempt: it folds the coach's OLDER still-owed changes in,
// exactly as the sweep does, so managers never get the newest state first and
// a stale one after it.
describe('deliverOwedAvailabilityNotices (the save)', () => {
  it("owed change 1 + in-band change 2: ONE notice under change 2's plain key, both rows stamped", async () => {
    const db = world({
      queue: [
        { id: 'ch-1', profile_id: COACH, actor_id: COACH, before: [MON], after: [], created_at: '2026-09-24T22:30:00Z' },
        { id: 'ch-2', profile_id: COACH, actor_id: COACH, before: [], after: [TUE], created_at: new Date(NOON).toISOString() },
      ],
    })
    expect(await deliverOwedAvailabilityNotices(db, COACH, { nowMs: NOON })).toEqual({ status: 'sent', sent: 3 })
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
    const [, key, , payload] = sendPushOnce.mock.calls[0]
    expect(key).toBe(availabilityEventKey('ch-2'))
    expect(payload.body).toBe('Sam Demo is now unavailable Tuesdays, all day; available again Mondays, 9am–12pm.')
    const read = db.calls.find((c) => c.table === 'staff_availability_changes' && !has(c, 'update'))
    expect(read.ops).toContainEqual(['eq', 'profile_id', COACH])
    expect(read.ops).toContainEqual(['is', 'notified_at', null])
    expect(read.ops).toContainEqual(['order', 'created_at', { ascending: true }])
    expect(stamps(db)[0].ops).toContainEqual(['in', 'id', ['ch-1', 'ch-2']])
  })

  it('a later save that undoes an owed one: both settled reverted, nobody pushed', async () => {
    const db = world({
      queue: [
        { id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: '2026-09-24T22:30:00Z' },
        { id: 'ch-2', profile_id: COACH, before: [TUE], after: [MON], created_at: new Date(NOON).toISOString() },
      ],
    })
    expect((await deliverOwedAvailabilityNotices(db, COACH, { nowMs: NOON })).status).toBe('reverted')
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)[0].ops).toContainEqual(['in', 'id', ['ch-1', 'ch-2']])
  })

  it('nothing owed (already settled elsewhere): nothing sent; an unreadable queue is an error', async () => {
    expect(await deliverOwedAvailabilityNotices(world({ queue: [] }), COACH, { nowMs: NOON })).toEqual({ status: 'none', sent: 0 })
    expect((await deliverOwedAvailabilityNotices(world({ queueError: { message: 'down' } }), COACH, { nowMs: NOON })).status).toBe('error')
    expect(sendPushOnce).not.toHaveBeenCalled()
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
    expect(key).toBe(availabilityRetryKey('ch-2', Date.parse('2026-09-25T06:05:00Z')))
    expect(payload.body).toBe('Sam Demo is now unavailable Tuesdays, all day; available again Mondays, 9am–12pm.')
    expect(stamps(db)[0].ops).toContainEqual(['in', 'id', ['ch-1', 'ch-2']])
  })

  it('excludes an actor only when every folded change was theirs', async () => {
    const q = (actorB) => [
      { id: 'ch-1', profile_id: COACH, actor_id: 'master', before: [MON], after: [], created_at: '2026-09-24T22:10:00Z' },
      { id: 'ch-2', profile_id: COACH, actor_id: actorB, before: [], after: [TUE], created_at: '2026-09-24T22:40:00Z' },
    ]
    await runAvailabilityNoticeSweep(world({ queue: q('master') }), { nowMs: Date.parse('2026-09-25T06:05:00Z') })
    expect(sendPushOnce.mock.calls[0][2]).not.toContain('master')
    sendPushOnce.mockClear()
    await runAvailabilityNoticeSweep(world({ queue: q(COACH) }), { nowMs: Date.parse('2026-09-25T06:05:00Z') })
    expect(sendPushOnce.mock.calls[0][2]).toContain('master')
  })

  it('leaves a coach alone while their newest owed change is inside the lease (the save may still be sending it)', async () => {
    const db = world({ queue: [{ id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: new Date(NOON - AVAILABILITY_NOTICE_LEASE_MS + 60_000).toISOString() }] })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: NOON })).toMatchObject({ leased: 1, sent: 0, errors: 0 })
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)).toHaveLength(0)
  })

  it('CRASH between claim and send: the save claimed the plain key and died; the sweep still delivers (a duplicate at worst, never a loss)', async () => {
    // A ledger-faithful sendPushOnce: a claimed (key, recipient) is never sent again.
    const claimed = new Set()
    sendPushOnce.mockImplementation(async (_db, key, ids) => {
      const fresh = ids.filter((id) => !claimed.has(`${key}|${id}`))
      fresh.forEach((id) => claimed.add(`${key}|${id}`))
      return { sent: fresh.length, skipped: 0, invalidated: 0, failed: 0, deduped: ids.length - fresh.length }
    })
    // The route's after() claimed every recipient under the plain key, then the process died before sendPush.
    for (const id of ['hc-b', 'master', 'mgr-a', 'own']) claimed.add(`${availabilityEventKey('ch-1')}|${id}`)
    const t = NOON + 20 * 60_000
    const db = world({ queue: [{ id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: new Date(NOON).toISOString() }] })
    const out = await runAvailabilityNoticeSweep(db, { nowMs: t })
    expect(sendPushOnce.mock.calls[0][1]).toBe(availabilityRetryKey('ch-1', t))
    expect(out).toMatchObject({ sent: 1, errors: 0 })
    expect(sendPushOnce.mock.results[0].value).resolves.toMatchObject({ sent: 4 })
    expect(stamps(db)[0].ops).toContainEqual(['update', { notified_at: new Date(t).toISOString(), notice_outcome: 'sent' }])
  })

  it('the retry key is fresh each tick slot, so a sweep that dies mid-send is retried, and shared within one slot', () => {
    expect(availabilityRetryKey('x', NOON)).toMatch(/^availability_changed:x:r\d+$/)
    expect(availabilityRetryKey('x', NOON)).toBe(availabilityRetryKey('x', NOON + 1000))
    expect(availabilityRetryKey('x', NOON)).not.toBe(availabilityRetryKey('x', NOON + AVAILABILITY_RETRY_SLOT_MS))
    expect(availabilityRetryKey('x', NOON)).not.toBe(availabilityEventKey('x'))
  })

  it("re-reads each coach's owed rows just before sending: a save that landed since the snapshot puts the coach back under the lease", async () => {
    const A = { id: 'ch-1', profile_id: COACH, before: [MON], after: [], created_at: new Date(NOON - 60 * 60_000).toISOString() }
    const B = { id: 'ch-2', profile_id: COACH, before: [], after: [TUE], created_at: new Date(NOON - 30_000).toISOString() }
    const db = world({ queue: (call) => (has(call, 'eq') ? [A, B] : [A]) })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: NOON })).toMatchObject({ pending: 1, leased: 1, sent: 0, errors: 0 })
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)).toHaveLength(0)
    const reread = db.calls.filter((c) => c.table === 'staff_availability_changes' && !has(c, 'update'))[1]
    expect(reread.ops).toContainEqual(['eq', 'profile_id', COACH])
    expect(reread.ops).toContainEqual(['is', 'notified_at', null])
  })

  it('sends what the fresh read says (folded), and skips a coach settled elsewhere since the snapshot', async () => {
    const A = { id: 'ch-1', profile_id: COACH, before: [MON], after: [], created_at: new Date(NOON - 60 * 60_000).toISOString() }
    const B = { id: 'ch-2', profile_id: COACH, before: [], after: [TUE], created_at: new Date(NOON - 40 * 60_000).toISOString() }
    let db = world({ queue: (call) => (has(call, 'eq') ? [A, B] : [A]) })
    await runAvailabilityNoticeSweep(db, { nowMs: NOON })
    expect(sendPushOnce.mock.calls[0][1]).toBe(availabilityRetryKey('ch-2', NOON))
    expect(stamps(db)[0].ops).toContainEqual(['in', 'id', ['ch-1', 'ch-2']])

    sendPushOnce.mockClear()
    db = world({ queue: (call) => (has(call, 'eq') ? [] : [A]) })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: NOON })).toMatchObject({ settled_elsewhere: 1, sent: 0, errors: 0 })
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it(`RETRY CAP: after ${4} sweep retries that each claimed and sent, it gives up (settled gave_up, warned), so a stamp that keeps failing cannot push ~95 times`, async () => {
    expect(AVAILABILITY_MAX_RETRIES).toBe(4)
    const old = { id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: new Date(NOON - 90 * 60_000).toISOString() }
    const claimRows = (n) => Array.from({ length: n }, (_, i) => [
      { event_key: `availability_changed:ch-1:r${i}` }, { event_key: `availability_changed:ch-1:r${i}` }, // two recipients per attempt
    ]).flat()
    let db = world({ queue: [old], claims: claimRows(4) })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: NOON })).toMatchObject({ gave_up: 1, sent: 0, errors: 0 })
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)[0].ops).toContainEqual(['update', { notified_at: new Date(NOON).toISOString(), notice_outcome: 'gave_up' }])
    expect(logWarn).toHaveBeenCalledWith('availability-notify', expect.stringMatching(/giving up/), expect.objectContaining({ attempts: 4 }))
    const read = db.calls.find((c) => c.table === 'push_event_sends')
    // escapeLikePattern makes the `_` in the key literal; only the trailing % is a wildcard.
    expect(read.ops).toContainEqual(['like', 'event_key', 'availability\\_changed:ch-1:r%'])

    db = world({ queue: [old], claims: claimRows(3) })
    await runAvailabilityNoticeSweep(db, { nowMs: NOON })
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
  })

  it('an unreadable attempt count sends anyway (a duplicate beats a loss) and warns', async () => {
    const old = { id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: new Date(NOON - 90 * 60_000).toISOString() }
    const db = world({ queue: [old], claimsError: { message: 'down' } })
    await runAvailabilityNoticeSweep(db, { nowMs: NOON })
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalled()
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
