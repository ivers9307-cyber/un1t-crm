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
import {
  publishNotifyRowsForBlocks, notifyStaffOfPublish, renotifyChangedCoaches,
  summariseCoachChanges, changeSummaryLine, buildChangeSummaryMessage, notifyRosterPublished,
} from './roster-notify'

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

    expect(res).toMatchObject({ notified: 1, delivered: 1 })
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

    expect(res).toMatchObject({ notified: 1, delivered: 1 })
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

    expect(res).toMatchObject({ notified: 1, delivered: 1 })
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

    expect(res).toMatchObject({ notified: 1, delivered: 0 })
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

    expect(res).toMatchObject({ notified: 1, delivered: 0 })
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

    expect(res).toMatchObject({ notified: 2, delivered: 1 })
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
    expect(res).toEqual({ notified: 0, delivered: 0, coachIds: [], lostCoachIds: [] })
    expect(notifyUsers).not.toHaveBeenCalled()
  })
})

// PUBSUMMARY.1 — a coach with changes to shifts they already had AND newly
// published shifts hears it all in the one "New schedule published" message.
describe('notifyStaffOfPublish — changes folded in (PUBSUMMARY.1)', () => {
  const range = { startDate: '2026-06-08', endDate: '2026-06-14', locationId: 'l1' }
  const db = { from: () => ({ insert: () => Promise.resolve({ data: [], error: null }) }) }
  const item = { kind: 'added', blockDate: '2026-06-09', name: 'Morning', startTime: '06:00:00', endTime: '09:00:00' }

  beforeEach(() => { vi.clearAllMocks(); notifyUsers.mockResolvedValue({ sent: 1 }) })

  it('lists the changes in the email and counts them in the push', async () => {
    const res = await notifyStaffOfPublish(db, [{ id: 'a1', profile_id: 'p1' }, { id: 'a2', profile_id: 'p2' }], {
      ...range, changeSummaries: new Map([['p1', [item]]]),
    })
    expect(notifyUsers).toHaveBeenCalledTimes(2)
    const p1 = notifyUsers.mock.calls.find((c) => c[0][0] === 'p1')[1]
    expect(p1.body).toBe('Your shifts for 2026-06-08 – 2026-06-14 are live, with 1 change to shifts you already had. Tap to view.')
    expect(p1.emailLines).toEqual(['Added: Tue 9 Jun, Morning 6–9am'])
    const p2 = notifyUsers.mock.calls.find((c) => c[0][0] === 'p2')[1]
    expect(p2.emailLines).toBeUndefined()
    expect(res).toMatchObject({ coachIds: ['p1', 'p2'], lostCoachIds: [] })
  })

  it('a coach with changes whose send hit a failed read is reported lost', async () => {
    notifyUsers.mockResolvedValue({ sent: 0, failed: 1, read_failed: 1 })
    const res = await notifyStaffOfPublish(db, [{ id: 'a1', profile_id: 'p1' }, { id: 'a2', profile_id: 'p2' }], {
      ...range, changeSummaries: new Map([['p1', [item]]]),
    })
    // p2 had no changes riding on it: nothing of theirs to keep.
    expect(res.lostCoachIds).toEqual(['p1'])
  })
})

// PUBSUMMARY.1 — each coach's held changes, netted against the roster now.
describe('summariseCoachChanges', () => {
  const block = (id, assignments, over = {}) => [id, {
    id, block_date: '2026-09-22', start_time: '06:00:00', end_time: '09:00:00',
    shift_templates: { name: 'Morning' }, shift_assignments: assignments, ...over,
  }]
  const on = (profile_id, over = {}) => ({ profile_id, status: 'scheduled', start_time_override: null, end_time_override: null, ...over })
  const r = (id, action, block_id = 'b1', block_date = '2026-09-22') => ({ id, action, block_id, block_date, coach_id: 'c1' })

  it('added and still on: added, with the window now', () => {
    const blocks = new Map([block('b1', [on('c1')])])
    expect(summariseCoachChanges([r('1', 'assigned')], blocks, 'c1')).toEqual([
      { kind: 'added', blockDate: '2026-09-22', name: 'Morning', startTime: '06:00:00', endTime: '09:00:00' },
    ])
  })

  it('added then removed before Publish: nothing to tell', () => {
    const blocks = new Map([block('b1', [])])
    expect(summariseCoachChanges([r('1', 'assigned'), r('2', 'unassigned')], blocks, 'c1')).toEqual([])
  })

  it('removed then put back, times untouched: nothing to tell', () => {
    const blocks = new Map([block('b1', [on('c1')])])
    expect(summariseCoachChanges([r('1', 'unassigned'), r('2', 'assigned')], blocks, 'c1')).toEqual([])
  })

  it('removed: removed, with the shift\'s times', () => {
    const blocks = new Map([block('b1', [on('c2'), on('c1', { status: 'cancelled' })])])
    expect(summariseCoachChanges([r('1', 'unassigned')], blocks, 'c1')).toMatchObject([{ kind: 'removed', startTime: '06:00:00' }])
  })

  it('times changed: changed, with the coach\'s own override as the window now', () => {
    const blocks = new Map([block('b1', [on('c1', { start_time_override: '07:00:00' })])])
    expect(summariseCoachChanges([r('1', 'time_changed'), r('2', 'time_changed')], blocks, 'c1')).toEqual([
      { kind: 'changed', blockDate: '2026-09-22', name: 'Morning', startTime: '07:00:00', endTime: '09:00:00' },
    ])
  })

  it('a deleted shift (no block, or block_id null) can only be a removal', () => {
    const rows = [r('1', 'unassigned', null, '2026-09-23'), r('2', 'assigned', 'gone', '2026-09-24')]
    expect(summariseCoachChanges(rows, new Map(), 'c1')).toEqual([
      { kind: 'removed', blockDate: '2026-09-23', name: null, startTime: null, endTime: null },
    ])
  })

  it('shifts unreadable: each reads as its last change, without times', () => {
    const rows = [r('1', 'assigned', 'b1'), r('2', 'unassigned', 'b2', '2026-09-21'), r('3', 'time_changed', 'b3', '2026-09-25')]
    expect(summariseCoachChanges(rows, null, 'c1').map((i) => [i.kind, i.blockDate])).toEqual([
      ['removed', '2026-09-21'], ['added', '2026-09-22'], ['changed', '2026-09-25'],
    ])
  })
})

describe('changeSummaryLine / buildChangeSummaryMessage', () => {
  const item = (kind, blockDate, over = {}) => ({ kind, blockDate, name: 'Morning', startTime: '06:00:00', endTime: '09:00:00', ...over })

  it('one line per kind', () => {
    expect(changeSummaryLine(item('added', '2026-09-22'))).toBe('Added: Tue 22 Sep, Morning 6–9am')
    expect(changeSummaryLine(item('removed', '2026-09-23', { name: null }))).toBe('Removed: Wed 23 Sep, 6–9am')
    expect(changeSummaryLine(item('changed', '2026-09-24', { startTime: '07:00:00' }))).toBe('New times: Thu 24 Sep, Morning now 7–9am')
    expect(changeSummaryLine(item('removed', '2026-09-25', { name: null, startTime: null, endTime: null }))).toBe('Removed: Fri 25 Sep')
  })

  it('one change: the line is the push', () => {
    expect(buildChangeSummaryMessage([item('added', '2026-09-22')])).toEqual({
      title: 'Roster updated', body: 'Added: Tue 22 Sep, Morning 6–9am.', emailLines: ['Added: Tue 22 Sep, Morning 6–9am'],
    })
  })

  it('several: the push names two, the email lists every one', () => {
    const msg = buildChangeSummaryMessage([item('added', '2026-09-22'), item('removed', '2026-09-23'), item('added', '2026-09-24')])
    expect(msg.body).toBe('3 changes to your shifts. Added: Tue 22 Sep, Morning 6–9am; Removed: Wed 23 Sep, Morning 6–9am; and 1 more. Tap to view.')
    expect(msg.emailLines).toHaveLength(3)
  })
})

// NOTIFY.1 / PUBSUMMARY.1 — at Publish, every held change is told, ONE message
// per coach. Called by both POST /api/schedule/rosters and the approve route.
// A change dated before today is stamped and never told; every collected row
// is stamped, except a coach the send may have left untold.
describe('renotifyChangedCoaches (PUBSUMMARY.1 summary)', () => {
  const range = { locationId: 'loc-1', periodStart: '2026-09-21', periodEnd: '2026-09-27', todayStr: '2026-09-16' }
  // The live shifts the summary nets against.
  function blocksDb(blocks, error = null) {
    const chain = { select: () => chain, in: () => Promise.resolve({ data: error ? null : blocks, error }) }
    return { from: () => chain }
  }
  const live = (id, block_date, coaches) => ({
    id, block_date, start_time: '06:00:00', end_time: '09:00:00', shift_templates: { name: 'Morning' },
    shift_assignments: coaches.map((profile_id) => ({ profile_id, status: 'scheduled' })),
  })

  beforeEach(() => { vi.clearAllMocks(); notifyUsers.mockResolvedValue({ sent: 1 }) })

  it('one message per coach listing every change, and every collected row stamped', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-21' },
      { id: 'ch2', coach_id: 'c1', action: 'assigned', block_id: 'b2', block_date: '2026-09-22' },
      { id: 'ch3', coach_id: 'c2', action: 'assigned', block_id: 'b3', block_date: '2026-09-23' },
    ])
    const db = blocksDb([live('b1', '2026-09-21', ['c1']), live('b2', '2026-09-22', ['c1']), live('b3', '2026-09-23', ['c2'])])
    const res = await renotifyChangedCoaches(db, range)
    expect(notifyUsers).toHaveBeenCalledTimes(2)
    expect(notifyUsers).toHaveBeenCalledWith(['c1'], expect.objectContaining({
      title: 'Roster updated',
      body: '2 changes to your shifts. Added: Mon 21 Sep, Morning 6–9am; Added: Tue 22 Sep, Morning 6–9am. Tap to view.',
      emailLines: ['Added: Mon 21 Sep, Morning 6–9am', 'Added: Tue 22 Sep, Morning 6–9am'],
      category: 'schedule',
      data: { type: 'schedule_updated', start_date: '2026-09-21', end_date: '2026-09-27', block_date: '2026-09-21', location_id: 'loc-1' },
    }))
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['ch1', 'ch2', 'ch3'])
    expect(res).toEqual({ notified: 2 })
  })

  it('a coach whose changes net to nothing is not messaged, but the rows are stamped', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-21' },
      { id: 'ch2', coach_id: 'c1', action: 'unassigned', block_id: 'b1', block_date: '2026-09-21' },
    ])
    const db = blocksDb([live('b1', '2026-09-21', [])])
    expect(await renotifyChangedCoaches(db, range)).toEqual({ notified: 0 })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['ch1', 'ch2'])
  })

  it('sends nothing when there is nothing to tell', async () => {
    collectUnnotifiedChanges.mockResolvedValue([])
    expect(await renotifyChangedCoaches(blocksDb([]), range)).toEqual({ notified: 0 })
    expect(notifyUsers).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    collectUnnotifiedChanges.mockRejectedValue(new Error('db down'))
    expect(await renotifyChangedCoaches({}, range)).toEqual({ notified: 0 })
    expect(logWarn).toHaveBeenCalled()
  })

  it('past-dated changes are stamped and never told; a change dated today is told', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-10' },
      { id: 'ch2', coach_id: 'c2', action: 'assigned', block_id: 'b2', block_date: '2026-09-16' },
    ])
    const db = blocksDb([live('b2', '2026-09-16', ['c2'])])
    const res = await renotifyChangedCoaches(db, range)
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers.mock.calls[0][0]).toEqual(['c2'])
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['ch1', 'ch2'])
    expect(res).toEqual({ notified: 1 })
  })

  it('shifts unreadable: still one message each, from the last change', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'unassigned', block_id: 'b1', block_date: '2026-09-21' },
    ])
    await renotifyChangedCoaches(blocksDb([], { message: 'timeout' }), range)
    expect(notifyUsers).toHaveBeenCalledWith(['c1'], expect.objectContaining({ body: 'Removed: Mon 21 Sep.' }))
  })

  it('when the send throws, that coach\'s rows are kept and the rest are stamped', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-21' },
      { id: 'ch2', coach_id: 'c2', action: 'assigned', block_id: 'b2', block_date: '2026-09-21' },
    ])
    notifyUsers.mockRejectedValueOnce(new Error('push down'))
    const db = blocksDb([live('b1', '2026-09-21', ['c1']), live('b2', '2026-09-21', ['c2'])])
    await renotifyChangedCoaches(db, range)
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['ch2'])
  })

  // C16 PUSHREADERR.1 — a read inside notifyUsers failed AND left someone
  // untold: this is the final attempt for those rows, so they are kept for the
  // next publish. A failed read that lost nobody stamps as normal.
  it('a failed read that lost someone keeps that coach\'s rows; one that lost nobody stamps', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-21' },
      { id: 'ch2', coach_id: 'c2', action: 'assigned', block_id: 'b2', block_date: '2026-09-21' },
    ])
    notifyUsers
      .mockResolvedValueOnce({ sent: 0, failed: 0, emailed: 0, email_failed: 1, read_failed: 1 })
      .mockResolvedValueOnce({ sent: 0, failed: 0, emailed: 1, email_failed: 0, read_failed: 1 })
    const db = blocksDb([live('b1', '2026-09-21', ['c1']), live('b2', '2026-09-21', ['c2'])])
    const res = await renotifyChangedCoaches(db, range)
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['ch2'])
    expect(res).toEqual({ notified: 2 })
  })

  it('coaches the publish notice already told are skipped; a lost one keeps its rows', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-21' },
      { id: 'ch2', coach_id: 'c2', action: 'assigned', block_id: 'b2', block_date: '2026-09-21' },
    ])
    const db = blocksDb([live('b1', '2026-09-21', ['c1']), live('b2', '2026-09-21', ['c2'])])
    const res = await renotifyChangedCoaches(db, { ...range, told: { coachIds: ['c1', 'c2'], lostCoachIds: ['c2'] } })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['ch1'])
    expect(res).toEqual({ notified: 0 })
  })
})

describe('notifyRosterPublished (PUBSUMMARY.1)', () => {
  // shift_assignments: the newly published blocks; shift_blocks: the summary's
  // live read; schedule_notifications: the publish notice's record.
  function publishDb({ flipped = [], blocks = [] } = {}) {
    return {
      from(table) {
        if (table === 'shift_assignments') {
          const q = { select: () => q, in: () => Promise.resolve({ data: flipped, error: null }) }
          return q
        }
        if (table === 'shift_blocks') {
          const q = { select: () => q, in: () => Promise.resolve({ data: blocks, error: null }) }
          return q
        }
        if (table === 'schedule_notifications') return { insert: () => Promise.resolve({ error: null }) }
        throw new Error(`unexpected table ${table}`)
      },
    }
  }

  beforeEach(() => { vi.clearAllMocks(); notifyUsers.mockResolvedValue({ sent: 1 }) })

  it('one message per coach: new shifts with changes folded in, and a summary for the rest', async () => {
    collectUnnotifiedChanges.mockResolvedValue([
      { id: 'ch1', coach_id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-21' },
      { id: 'ch2', coach_id: 'c2', action: 'assigned', block_id: 'b1', block_date: '2026-09-21' },
    ])
    const db = publishDb({
      flipped: [{ id: 'a9', profile_id: 'c1', status: 'scheduled', shift_blocks: { location_id: 'loc-1', block_date: '2026-09-27' } }],
      blocks: [{
        id: 'b1', block_date: '2026-09-21', start_time: '06:00:00', end_time: '09:00:00', shift_templates: { name: 'Morning' },
        shift_assignments: [{ profile_id: 'c1', status: 'scheduled' }, { profile_id: 'c2', status: 'scheduled' }],
      }],
    })
    const res = await notifyRosterPublished(db, {
      newBlockIds: ['b9'], locationId: 'loc-1', periodStart: '2026-09-21', periodEnd: '2026-09-27', todayStr: '2026-09-16',
    })
    expect(notifyUsers).toHaveBeenCalledTimes(2)
    expect(notifyUsers.mock.calls.map((c) => [c[0][0], c[1].title])).toEqual([
      ['c1', 'New schedule published'],
      ['c2', 'Roster updated'],
    ])
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['ch1', 'ch2'])
    expect(res).toEqual({ notified: 2 })
  })
})
