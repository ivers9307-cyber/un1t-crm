// RETIRE-SHIFTS-MIRROR.6 — tests for publishNotifyRowsForBlocks, which
// sources the publish notify-list from the Roster v2 model (assignments on
// the newly-published blocks) instead of the dropped public.shifts flip.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push', () => ({ sendPush: vi.fn(() => Promise.resolve({ sent: 1 })) }))
vi.mock('./log', () => ({ logWarn: vi.fn() }))

import { sendPush } from './push'
import { logWarn } from './log'
import { publishNotifyRowsForBlocks, notifyStaffOfPublish } from './roster-notify'

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
    return { from: () => ({ insert: () => Promise.resolve(result) }) }
  }

  beforeEach(() => {
    sendPush.mockClear()
    logWarn.mockClear()
  })

  it('logs a failed insert and still sends the push', async () => {
    const db = makeInsertDb({ data: null, error: { code: '23503', message: 'fk violation' } })

    const res = await notifyStaffOfPublish(db, shifts, range)

    expect(res).toEqual({ notified: 1 })
    expect(logWarn).toHaveBeenCalledWith(
      'roster-notify', 'notification log insert failed', { err: 'fk violation' },
    )
    // The push is the notification; the row is only the record of it, so a lost
    // record must never cost the coach the message.
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0][0]).toEqual(['p1'])
  })

  it('logs nothing when the insert succeeds', async () => {
    const db = makeInsertDb({ data: [{ id: 'n1' }], error: null })

    const res = await notifyStaffOfPublish(db, shifts, range)

    expect(res).toEqual({ notified: 1 })
    expect(logWarn).not.toHaveBeenCalled()
    expect(sendPush).toHaveBeenCalledTimes(1)
  })
})
