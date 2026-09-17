// RETIRE-SHIFTS-MIRROR.6 — tests for publishNotifyRowsForBlocks, which
// sources the publish notify-list from the Roster v2 model (assignments on
// the newly-published blocks) instead of the dropped public.shifts flip.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
vi.mock('./notify', () => ({ notifyUsers: vi.fn(() => Promise.resolve({ sent: 1 })) }))
vi.mock('./roster-change-log', () => ({
  collectUnnotifiedChanges: vi.fn(),
  distinctCoachIds: (rows) => [...new Set((rows || []).map((r) => r.coach_id))],
  markChangesNotified: vi.fn(() => Promise.resolve()),
}))

import { logWarn } from './log'
import { notifyUsers } from './notify'
import { collectUnnotifiedChanges, markChangesNotified } from './roster-change-log'
import { publishNotifyRowsForBlocks, notifyStaffOfPublish, renotifyChangedCoaches } from './roster-notify'

function makeDb(result) {
  const builder = {
    select() { return this },
    in() { return this },
    then(resolve) { return Promise.resolve(result).then(resolve) },
  }
  return { from() { return builder } }
}

describe('publishNotifyRowsForBlocks', () => {
  it('returns [] for an empty block list without querying', async () => {
    let queried = false
    const db = { from() { queried = true; return {} } }
    expect(await publishNotifyRowsForBlocks(db, [])).toEqual([])
    expect(queried).toBe(false)
  })

  it('maps assignments to notify rows { id, profile_id, location_id, shift_date }', async () => {
    const db = makeDb({
      data: [
        { id: 'a1', profile_id: 'p1', shift_blocks: { location_id: 'loc1', block_date: '2026-06-08' } },
        { id: 'a2', profile_id: 'p2', shift_blocks: { location_id: 'loc1', block_date: '2026-06-09' } },
      ],
      error: null,
    })
    const rows = await publishNotifyRowsForBlocks(db, ['b1', 'b2'])
    expect(rows).toEqual([
      { id: 'a1', profile_id: 'p1', location_id: 'loc1', shift_date: '2026-06-08' },
      { id: 'a2', profile_id: 'p2', location_id: 'loc1', shift_date: '2026-06-09' },
    ])
  })

  // ROSTER-FIX.1 — a coach whose assignment was cancelled is not on the
  // roster any more, so publishing it must not notify them.
  it('publishNotifyRowsForBlocks skips cancelled assignments', async () => {
    const db = makeDb({
      data: [
        { id: 'a1', profile_id: 'p1', status: 'scheduled', shift_blocks: { location_id: 'l', block_date: '2026-06-01' } },
        { id: 'a2', profile_id: 'p2', status: 'cancelled', shift_blocks: { location_id: 'l', block_date: '2026-06-01' } },
      ],
      error: null,
    })
    const rows = await publishNotifyRowsForBlocks(db, ['b1'])
    expect(rows.map((r) => r.profile_id)).toEqual(['p1'])
  })

  it('skips assignments with no joined block and swallows query errors', async () => {
    const partial = makeDb({ data: [{ id: 'a1', profile_id: 'p1', shift_blocks: null }], error: null })
    expect(await publishNotifyRowsForBlocks(partial, ['b1'])).toEqual([])

    const bad = makeDb({ data: null, error: { message: 'boom' } })
    expect(await publishNotifyRowsForBlocks(bad, ['b1'])).toEqual([])
  })
})

// ROSTER-FIX.8f — the notification-log insert sat inside a try/catch that could
// never catch: PostgREST RESOLVES with an `error` property instead of throwing,
// so a failed insert left no trace anywhere. Mig 603's new FK on
// schedule_notifications.shift_id makes a 23503 genuinely reachable, which is
// what turned a dead branch into a real one.
describe('notifyStaffOfPublish — notification-log insert', () => {
  const shifts = [{ id: 'a1', profile_id: 'p1', location_id: 'l1', shift_date: '2026-06-08' }]
  const range = { startDate: '2026-06-08', endDate: '2026-06-08', locationId: 'l1' }

  function makeInsertDb(result) {
    const rows = []
    return {
      rows,
      from: () => ({ insert: (payload) => { rows.push(...payload); return Promise.resolve(result) } }),
    }
  }

  beforeEach(() => {
    notifyUsers.mockClear()
    notifyUsers.mockResolvedValue({ sent: 1 })
    logWarn.mockClear()
  })

  it('logs a failed insert and still sends the notification', async () => {
    const db = makeInsertDb({ data: null, error: { code: '23503', message: 'fk violation' } })

    const res = await notifyStaffOfPublish(db, shifts, range)

    expect(res).toEqual({ notified: 1, delivered: 1 })
    expect(logWarn).toHaveBeenCalledWith(
      'roster-notify', 'notification log insert failed', { err: 'fk violation' },
    )
    // The message is the notification; the row is only the record of it, so a
    // lost record must never cost the coach the message.
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers.mock.calls[0][0]).toEqual(['p1'])
  })

  it('logs nothing when the insert succeeds', async () => {
    const db = makeInsertDb({ data: [{ id: 'n1' }], error: null })

    const res = await notifyStaffOfPublish(db, shifts, range)

    expect(res).toEqual({ notified: 1, delivered: 1 })
    expect(logWarn).not.toHaveBeenCalled()
    expect(notifyUsers).toHaveBeenCalledTimes(1)
  })
})

// PUBNOTIFY.1 — the first-publish notice used to be a bare sendPush whose
// record claimed channel 'email' and never set `delivered`, so a coach without
// the app heard nothing and the table said otherwise.
describe('notifyStaffOfPublish — real channels, real delivery', () => {
  const range = { startDate: '2026-06-08', endDate: '2026-06-14', locationId: 'l1' }

  function makeInsertDb() {
    const rows = []
    return {
      rows,
      from: () => ({ insert: (payload) => { rows.push(...payload); return Promise.resolve({ data: payload, error: null }) } }),
    }
  }

  beforeEach(() => {
    notifyUsers.mockClear()
    logWarn.mockClear()
  })

  it('sends push WITH email fallback under the schedule category', async () => {
    notifyUsers.mockResolvedValue({ sent: 0, emailed: 1 })
    const db = makeInsertDb()

    await notifyStaffOfPublish(db, [{ id: 'a1', profile_id: 'p1' }], range)

    const payload = notifyUsers.mock.calls[0][1]
    expect(payload.category).toBe('schedule')
    expect(payload.emailSubject).toBeTruthy()
    expect(payload.data).toMatchObject({ type: 'schedule_published', start_date: '2026-06-08', end_date: '2026-06-14' })
  })

  it("records 'email' + delivered when only the fallback landed", async () => {
    notifyUsers.mockResolvedValue({ sent: 0, emailed: 1 })
    const db = makeInsertDb()

    const res = await notifyStaffOfPublish(db, [{ id: 'a1', profile_id: 'p1' }], range)

    expect(res).toEqual({ notified: 1, delivered: 1 })
    expect(db.rows[0]).toMatchObject({ profile_id: 'p1', channel: 'email', delivered: true })
    expect(db.rows[0].metadata).toMatchObject({ push_sent: 0, emails_sent: 1, opted_out: false })
  })

  it("records 'push' when the push landed", async () => {
    notifyUsers.mockResolvedValue({ sent: 1, emailed: 0 })
    const db = makeInsertDb()

    await notifyStaffOfPublish(db, [{ id: 'a1', profile_id: 'p1' }], range)

    expect(db.rows[0]).toMatchObject({ channel: 'push', delivered: true })
  })

  it("records 'none' + delivered:false for a coach nothing reached", async () => {
    notifyUsers.mockResolvedValue({ sent: 0, emailed: 0, skipped: 0 })
    const db = makeInsertDb()

    const res = await notifyStaffOfPublish(db, [{ id: 'a1', profile_id: 'p1' }], range)

    expect(res).toEqual({ notified: 1, delivered: 0 })
    expect(db.rows[0]).toMatchObject({ channel: 'none', delivered: false })
    expect(db.rows[0].metadata.opted_out).toBe(false)
  })

  it('flags an opted-out coach rather than emailing around them', async () => {
    // push.js counts the master switch / notify_schedule opt-out as `skipped`,
    // and notifyUsers applies the same gate before the email fallback — so the
    // coach is deliberately left to the re-publish safety net.
    notifyUsers.mockResolvedValue({ sent: 0, emailed: 0, skipped: 1 })
    const db = makeInsertDb()

    const res = await notifyStaffOfPublish(db, [{ id: 'a1', profile_id: 'p1' }], range)

    expect(res).toEqual({ notified: 1, delivered: 0 })
    expect(db.rows[0]).toMatchObject({ channel: 'none', delivered: false })
    expect(db.rows[0].metadata.opted_out).toBe(true)
  })

  it('judges each coach on their own and never stops on one failure', async () => {
    notifyUsers
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ sent: 1 })
    const db = makeInsertDb()

    const res = await notifyStaffOfPublish(db, [
      { id: 'a1', profile_id: 'p1' },
      { id: 'a2', profile_id: 'p2' },
    ], range)

    expect(res).toEqual({ notified: 2, delivered: 1 })
    expect(db.rows.map((r) => [r.profile_id, r.channel, r.delivered])).toEqual([
      ['p1', 'none', false],
      ['p2', 'push', true],
    ])
  })

  it('groups a coach\'s shifts into one message and counts them', async () => {
    notifyUsers.mockResolvedValue({ sent: 1 })
    const db = makeInsertDb()

    await notifyStaffOfPublish(db, [
      { id: 'a1', profile_id: 'p1' },
      { id: 'a2', profile_id: 'p1' },
      { id: 'a3', profile_id: 'p2' },
    ], range)

    expect(notifyUsers).toHaveBeenCalledTimes(2)
    expect(db.rows.find((r) => r.profile_id === 'p1').metadata.shift_count).toBe(2)
    expect(db.rows.find((r) => r.profile_id === 'p1').shift_id).toBe('a1')
  })

  it('does nothing for an empty shift list', async () => {
    const res = await notifyStaffOfPublish({ from: () => { throw new Error('should not query') } }, [], range)
    expect(res).toEqual({ notified: 0, delivered: 0 })
    expect(notifyUsers).not.toHaveBeenCalled()
  })
})

// NOTIFY.1 — the re-publish safety net. Extracted from the publish route's
// inline block so both POST /api/schedule/rosters and the approve route can
// call it. ADDITION from review: it must not send a late notice about a
// shift that has already happened — only coaches with at least one FUTURE
// (block_date >= today) collected change get pushed, but every collected
// row is still stamped (a past row needs no message, but must stop being
// "unnotified" or it would be re-read forever).
describe('renotifyChangedCoaches (NOTIFY.1 safety net)', () => {
  const range = { locationId: 'loc-1', periodStart: '2026-09-21', periodEnd: '2026-09-27', todayStr: '2026-09-16' }

  beforeEach(() => { vi.clearAllMocks() })

  it('pushes each coach with an unsent FUTURE change once and stamps every collected row', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', block_date: '2026-09-21' },
      { id: 'ch2', coach_id: 'c1', block_date: '2026-09-22' },
      { id: 'ch3', coach_id: 'c2', block_date: '2026-09-23' },
    ])
    const res = await renotifyChangedCoaches({}, range)
    expect(notifyUsers).toHaveBeenCalledWith(['c1', 'c2'], expect.objectContaining({
      title: 'Roster updated',
      // NOTIFY.1 review — formatShiftDate, not the raw ISO range.
      body: 'Your shifts between Mon 21 Sep and Sun 27 Sep have been updated.',
      category: 'schedule',
      data: { type: 'schedule_updated', start_date: '2026-09-21', end_date: '2026-09-27', location_id: 'loc-1' },
    }))
    expect(markChangesNotified).toHaveBeenCalledWith({}, ['ch1', 'ch2', 'ch3'])
    expect(res).toEqual({ notified: 2 })
  })

  it('a single-day range reads as one date, not a range', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', block_date: '2026-09-18' },
    ])
    await renotifyChangedCoaches({}, { locationId: 'loc-1', periodStart: '2026-09-18', periodEnd: '2026-09-18', todayStr: '2026-09-16' })
    expect(notifyUsers).toHaveBeenCalledWith(['c1'], expect.objectContaining({
      body: 'Your shifts for Fri 18 Sep have been updated.',
    }))
  })

  it('sends nothing when there is nothing to tell', async () => {
    collectUnnotifiedChanges.mockResolvedValue([])
    expect(await renotifyChangedCoaches({}, range)).toEqual({ notified: 0 })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(markChangesNotified).toHaveBeenCalledWith({}, [])
  })

  it('never throws', async () => {
    collectUnnotifiedChanges.mockRejectedValue(new Error('db down'))
    expect(await renotifyChangedCoaches({}, range)).toEqual({ notified: 0 })
    expect(logWarn).toHaveBeenCalled()
  })

  it('a coach with only past-dated changes is not notified, but their rows are still stamped', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', block_date: '2026-09-10' }, // past — c1 only has this one
      { id: 'ch2', coach_id: 'c2', block_date: '2026-09-21' }, // future
    ])
    const res = await renotifyChangedCoaches({}, range)
    expect(notifyUsers).toHaveBeenCalledWith(['c2'], expect.anything())
    expect(markChangesNotified).toHaveBeenCalledWith({}, ['ch1', 'ch2'])
    expect(res).toEqual({ notified: 1 })
  })

  it('sends nothing when every collected change is in the past, but still stamps them', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', block_date: '2026-09-01' },
      { id: 'ch2', coach_id: 'c2', block_date: '2026-09-10' },
    ])
    const res = await renotifyChangedCoaches({}, range)
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(markChangesNotified).toHaveBeenCalledWith({}, ['ch1', 'ch2'])
    expect(res).toEqual({ notified: 0 })
  })

  it('a change dated exactly today counts as future — the coach is notified', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', block_date: '2026-09-16' }, // todayStr in `range`
    ])
    const res = await renotifyChangedCoaches({}, range)
    expect(notifyUsers).toHaveBeenCalledWith(['c1'], expect.anything())
    expect(markChangesNotified).toHaveBeenCalledWith({}, ['ch1'])
    expect(res).toEqual({ notified: 1 })
  })

  it('when notifyUsers rejects, markChangesNotified is NOT called and it resolves { notified: 0 }', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', block_date: '2026-09-21' },
    ])
    notifyUsers.mockRejectedValueOnce(new Error('push down'))
    const res = await renotifyChangedCoaches({}, range)
    expect(markChangesNotified).not.toHaveBeenCalled()
    expect(res).toEqual({ notified: 0 })
    expect(logWarn).toHaveBeenCalled()
  })
})
