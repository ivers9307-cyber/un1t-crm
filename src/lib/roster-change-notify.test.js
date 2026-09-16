// NOTIFY.1 — a coach added to or removed from a PUBLISHED shift is told at
// the moment of change, one message per coach per request.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./notify', () => ({ notifyUsers: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn() }))

import { notifyUsers } from './notify'
import { logWarn } from './log'
import {
  formatShiftDate,
  buildRosterChangeMessage,
  notifyRosterChanges,
  publishedAdditions,
  logAndNotifyCopiedShifts,
} from './roster-change-notify'

function makeDb({ rangeResults = [], insertError = null } = {}) {
  const updates = []
  const inserts = []
  let rangeCall = 0
  return {
    updates,
    inserts,
    from(table) {
      if (table === 'roster_change_log') {
        const u = { table, filters: [] }
        const chain = {
          update(patch) { u.patch = patch; updates.push(u); return chain },
          eq(c, v) { u.filters.push(['eq', c, v]); return chain },
          in(c, v) { u.filters.push(['in', c, v]); return chain },
          is(c, v) { u.filters.push(['is', c, v]); return chain },
          insert(rows) {
            inserts.push(rows)
            return { then(onF, onR) { return Promise.resolve({ error: insertError }).then(onF, onR) } }
          },
          then(onF, onR) { return Promise.resolve({ error: null }).then(onF, onR) },
        }
        return chain
      }
      if (table === 'shift_assignments') {
        const result = rangeResults[rangeCall++] ?? { data: [], error: null }
        const chain = {
          select() { return chain },
          eq() { return chain },
          gte() { return chain },
          lte() { return chain },
          order() { return chain },
          then(onF, onR) { return Promise.resolve(result).then(onF, onR) },
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const change = (coachId, blockDate, action = 'assigned', blockId = `blk-${blockDate}`) => ({ coachId, blockId, blockDate, action })

beforeEach(() => {
  vi.clearAllMocks()
  notifyUsers.mockResolvedValue({ sent: 1, emailed: 0 })
})

describe('formatShiftDate', () => {
  it('renders a stable short day label', () => {
    expect(formatShiftDate('2026-09-18')).toBe('Fri 18 Sep')
    expect(formatShiftDate('2026-12-01')).toBe('Tue 1 Dec')
  })
})

describe('buildRosterChangeMessage', () => {
  it('one addition', () => {
    expect(buildRosterChangeMessage([change('c1', '2026-09-18')])).toEqual({
      title: 'Added to a shift',
      body: "You're now on the roster for Fri 18 Sep.",
    })
  })

  it('one removal', () => {
    expect(buildRosterChangeMessage([change('c1', '2026-09-18', 'unassigned')])).toEqual({
      title: 'Removed from a shift',
      body: "You're no longer on the roster for Fri 18 Sep.",
    })
  })

  it('a mix across days', () => {
    const msg = buildRosterChangeMessage([
      change('c1', '2026-09-20'),
      change('c1', '2026-09-18'),
      change('c1', '2026-09-22', 'unassigned'),
    ])
    expect(msg).toEqual({
      title: 'Roster updated',
      body: 'You were added to 2 shifts and removed from 1 shift between Fri 18 Sep and Tue 22 Sep.',
    })
  })

  it('several changes on one day', () => {
    const msg = buildRosterChangeMessage([change('c1', '2026-09-18', 'assigned', 'b1'), change('c1', '2026-09-18', 'assigned', 'b2')])
    expect(msg.body).toBe('You were added to 2 shifts on Fri 18 Sep.')
  })
})

describe('notifyRosterChanges', () => {
  const opts = (changes, actorId = 'mgr-1') => ({ locationId: 'loc-1', actorId, changes, todayStr: '2026-09-16' })

  it('sends one message per coach on the shift_adjusted category and stamps their rows on delivery', async () => {
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([
      change('c1', '2026-09-18'),
      change('c1', '2026-09-20'),
      change('c2', '2026-09-19', 'unassigned'),
    ]))
    expect(notifyUsers).toHaveBeenCalledTimes(2)
    const [ids, payload] = notifyUsers.mock.calls[0]
    expect(ids).toEqual(['c1'])
    expect(payload).toMatchObject({
      category: 'shift_adjusted',
      data: { type: 'shift_adjusted', block_date: '2026-09-18', location_id: 'loc-1' },
    })
    expect(res).toMatchObject({ notified: 2 })
    expect(db.updates[0].filters).toEqual([
      ['eq', 'location_id', 'loc-1'],
      ['eq', 'coach_id', 'c1'],
      ['in', 'block_id', ['blk-2026-09-18', 'blk-2026-09-20']],
      ['is', 'notified_at', null],
    ])
  })

  it('stamps changes to shifts already in the past, without sending', async () => {
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([change('c1', '2026-09-15')]))
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].filters).toEqual([
      ['eq', 'location_id', 'loc-1'],
      ['eq', 'coach_id', 'c1'],
      ['in', 'block_id', ['blk-2026-09-15']],
      ['is', 'notified_at', null],
    ])
    expect(res.skippedPast).toBe(1)
  })

  it('for a coach with mixed past and future changes, messages only the future ones but stamps all their block ids', async () => {
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([
      change('c1', '2026-09-15'),
      change('c1', '2026-09-20'),
    ]))
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    const [, payload] = notifyUsers.mock.calls[0]
    expect(payload.body).toBe("You're now on the roster for Sun 20 Sep.")
    expect(res.skippedPast).toBe(1)
    expect(res.notified).toBe(1)
    expect(db.updates[0].filters).toEqual([
      ['eq', 'location_id', 'loc-1'],
      ['eq', 'coach_id', 'c1'],
      ['in', 'block_id', ['blk-2026-09-15', 'blk-2026-09-20']],
      ['is', 'notified_at', null],
    ])
  })

  it('does not message a manager about their own change, but stamps it', async () => {
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([change('mgr-1', '2026-09-18')], 'mgr-1'))
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(1)
    expect(res.skippedSelf).toBe(1)
  })

  it('stamps when only the fallback email delivered', async () => {
    notifyUsers.mockResolvedValue({ sent: 0, emailed: 1 })
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([change('c1', '2026-09-18')]))
    expect(db.updates).toHaveLength(1)
    expect(res.notified).toBe(1)
  })

  it('stamps and counts optedOut when the coach turned the category off', async () => {
    notifyUsers.mockResolvedValue({ sent: 0, emailed: 0, skipped: 1 })
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([change('c1', '2026-09-18')]))
    expect(db.updates).toHaveLength(1)
    expect(res.optedOut).toBe(1)
    expect(res.notified).toBe(0)
  })

  it('leaves rows unstamped when nothing was delivered, so re-publish tries again', async () => {
    notifyUsers.mockResolvedValue({ sent: 0, emailed: 0, failed: 1 })
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([change('c1', '2026-09-18')]))
    expect(db.updates).toHaveLength(0)
    expect(res.undelivered).toBe(1)
  })

  it('ignores time changes, which already notify on their own', async () => {
    await notifyRosterChanges(makeDb(), opts([change('c1', '2026-09-18', 'time_changed')]))
    expect(notifyUsers).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    notifyUsers.mockRejectedValue(new Error('push down'))
    await expect(notifyRosterChanges(makeDb(), opts([change('c1', '2026-09-18')]))).resolves.toMatchObject({ notified: 0 })
    expect(logWarn).toHaveBeenCalled()
  })

  it("does not let one coach's failure stop the others", async () => {
    notifyUsers.mockImplementation(async (ids) => {
      if (ids[0] === 'c1') throw new Error('push down')
      return { sent: 1, emailed: 0 }
    })
    const db = makeDb()
    const res = await notifyRosterChanges(db, opts([
      change('c1', '2026-09-18'),
      change('c2', '2026-09-19'),
    ]))
    expect(res.notified).toBe(1)
    expect(logWarn).toHaveBeenCalled()
    const c2Update = db.updates.find((u) => u.filters.some((f) => f[1] === 'coach_id' && f[2] === 'c2'))
    expect(c2Update).toBeTruthy()
  })
})

describe('publishedAdditions', () => {
  const row = (block_id, profile_id, block_date, status) => ({ block_id, profile_id, shift_blocks: { block_date, rosters: status ? { status } : null } })

  it('returns only new coach/block pairs on published blocks', () => {
    const before = [row('b1', 'c1', '2026-09-21', 'published')]
    const after = [
      row('b1', 'c1', '2026-09-21', 'published'),
      row('b1', 'c2', '2026-09-21', 'published'),
      row('b2', 'c2', '2026-09-22', null),
    ]
    expect(publishedAdditions(before, after)).toEqual([
      { coachId: 'c2', blockId: 'b1', blockDate: '2026-09-21', action: 'assigned' },
    ])
  })
})

describe('logAndNotifyCopiedShifts', () => {
  it('logs and notifies coaches copied onto published blocks', async () => {
    const after = { data: [{ block_id: 'b1', profile_id: 'c2', shift_blocks: { block_date: '2026-09-21', rosters: { status: 'published' } } }], error: null }
    const db = makeDb({ rangeResults: [after] })
    const res = await logAndNotifyCopiedShifts(db, {
      locationId: 'loc-1', actorId: 'mgr-1', startDate: '2026-09-21', endDate: '2026-09-27',
      before: { rows: [], error: null, truncated: false }, via: 'copy_week', todayStr: '2026-09-16',
    })
    expect(db.inserts).toEqual([[{
      location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-21', actor_id: 'mgr-1',
      coach_id: 'c2', action: 'assigned', details: { via: 'copy_week' },
    }]])
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(res.logged).toBe(1)
  })

  it('still notifies and returns logged: 0 when the change-log insert fails', async () => {
    const after = { data: [{ block_id: 'b1', profile_id: 'c2', shift_blocks: { block_date: '2026-09-21', rosters: { status: 'published' } } }], error: null }
    const db = makeDb({ rangeResults: [after], insertError: { message: 'insert boom' } })
    const res = await logAndNotifyCopiedShifts(db, {
      locationId: 'loc-1', actorId: 'mgr-1', startDate: '2026-09-21', endDate: '2026-09-27',
      before: { rows: [], error: null, truncated: false }, via: 'copy_week', todayStr: '2026-09-16',
    })
    expect(db.inserts).toHaveLength(1)
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalled()
    expect(res.logged).toBe(0)
  })

  it('skips when the before-snapshot could not be read', async () => {
    const db = makeDb()
    const res = await logAndNotifyCopiedShifts(db, {
      locationId: 'loc-1', actorId: 'mgr-1', startDate: '2026-09-21', endDate: '2026-09-27',
      before: { rows: null, error: { message: 'boom' } }, via: 'copy_week',
    })
    expect(res).toEqual({ logged: 0, notify: null })
    expect(db.inserts).toHaveLength(0)
    expect(logWarn).toHaveBeenCalled()
  })
})
