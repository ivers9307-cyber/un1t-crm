// src/lib/block-edit-notify.test.js
// BLOCKEDIT.1 — telling coaches their published shift moved: once, inside
// quiet hours, from the */5 cron.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn() }))
vi.mock('./roster-change-log', () => ({ markChangesNotified: vi.fn(async () => {}) }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { notifyUsersOnce } = await import('./push-dedup')
const { markChangesNotified } = await import('./roster-change-log')
const { planTimeChangeNotices, timeChangeMessage, runShiftTimeChangeNotices } = await import('./block-edit-notify')

// Tue 29 Sep 2026, Dublin summer time (UTC+1).
const IN_BAND = Date.parse('2026-09-29T10:00:00Z')   // 11:00 Dublin
const QUIET = Date.parse('2026-09-29T21:30:00Z')     // 22:30 Dublin
const LOC = { id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin' }

const blockEmbed = (over = {}) => ({
  start_time: '10:00:00', end_time: '13:00:00',
  shift_templates: { name: 'Morning' },
  shift_assignments: [{ profile_id: 'u1', status: 'scheduled', start_time_override: null, end_time_override: null }],
  ...over,
})
const row = (id, over = {}) => ({
  id, location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-30', coach_id: 'u1',
  created_at: `2026-09-29T09:0${id.slice(-1)}:00Z`,
  details: { source: 'block_edit', from: { start_time: '09:00:00', end_time: '12:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' } },
  shift_blocks: blockEmbed(),
  ...over,
})

describe('timeChangeMessage', () => {
  it('names the shift, the day, the new and the old time', () => {
    expect(timeChangeMessage({
      templateName: 'Morning', blockDate: '2026-09-30',
      from: { start_time: '09:00:00', end_time: '12:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' },
    })).toEqual({ title: 'Shift time changed', body: 'Morning on Wed 30 Sep is now 10am–1pm (was 9am–12pm).' })
  })
})

describe('planTimeChangeNotices', () => {
  const opts = { todayStr: '2026-09-29', nowHHMMByLocation: { 'loc-1': '11:00' } }

  it('one message per coach per shift: oldest from, the window NOW, keyed on the newest row', () => {
    const r1 = row('r1', { details: { source: 'block_edit', from: { start_time: '08:00:00', end_time: '11:00:00' }, to: { start_time: '09:00:00', end_time: '12:00:00' } } })
    const r2 = row('r2')
    const { send, silent } = planTimeChangeNotices([r2, r1], opts)
    expect(silent).toEqual([])
    expect(send).toEqual([{
      key: 'shift_time_changed:r2', coachId: 'u1', locationId: 'loc-1', blockDate: '2026-09-30', templateName: 'Morning',
      from: { start_time: '08:00:00', end_time: '11:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' },
      rowIds: ['r1', 'r2'],
    }])
  })

  it('edited and put back: no message, every row stamped not_needed', () => {
    const r = row('r1', { shift_blocks: blockEmbed({ start_time: '09:00:00', end_time: '12:00:00' }) })
    const { send, silent } = planTimeChangeNotices([r], opts)
    expect(send).toEqual([])
    expect(silent.map((s) => s.id)).toEqual(['r1'])
  })

  it('the coach is off the shift, or it was deleted: no message', () => {
    const off = row('r1', { shift_blocks: blockEmbed({ shift_assignments: [{ profile_id: 'u1', status: 'cancelled' }] }) })
    const gone = row('r2', { coach_id: 'u2', block_id: null, shift_blocks: null })
    expect(planTimeChangeNotices([off, gone], opts)).toEqual({ send: [], silent: [off, gone] })
  })

  it('a shift that has already started today: no message', () => {
    const today = row('r1', { block_date: '2026-09-29' })
    expect(planTimeChangeNotices([today], opts).send).toEqual([])
    expect(planTimeChangeNotices([today], { ...opts, nowHHMMByLocation: { 'loc-1': '09:59' } }).send).toHaveLength(1)
  })

  it("the coach's own override counts as their window now", () => {
    const r = row('r1', { shift_blocks: blockEmbed({ shift_assignments: [{ profile_id: 'u1', status: 'scheduled', start_time_override: '10:30:00', end_time_override: null }] }) })
    expect(planTimeChangeNotices([r], opts).send[0].to).toEqual({ start_time: '10:30:00', end_time: '13:00:00' })
  })
})

function makeDb({ rows = [], readError = null } = {}) {
  const captured = { reads: [], stamps: [] }
  const db = {
    captured,
    from(table) {
      if (table !== 'roster_change_log') throw new Error(`unexpected table ${table}`)
      return {
        select(cols) {
          const q = { calls: [['select', cols]] }
          for (const m of ['in', 'eq', 'is', 'gte', 'order', 'range']) q[m] = (...a) => { q.calls.push([m, ...a]); return q }
          q.then = (res, rej) => { captured.reads.push(q.calls); return Promise.resolve({ data: readError ? null : rows, error: readError }).then(res, rej) }
          return q
        },
        update(patch) {
          const u = { patch, calls: [] }
          for (const m of ['eq', 'is']) u[m] = (...a) => { u.calls.push([m, ...a]); return u }
          u.select = () => u
          u.then = (res, rej) => { captured.stamps.push(u); return Promise.resolve({ data: [{ id: 'x' }], error: null }).then(res, rej) }
          return u
        },
      }
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  notifyUsersOnce.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, deduped: 0 })
})

describe('runShiftTimeChangeNotices', () => {
  it('in quiet hours it reads nothing and says so', async () => {
    const db = makeDb({ rows: [row('r1')] })
    const s = await runShiftTimeChangeNotices(db, { nowMs: QUIET, locations: [LOC] })
    expect(s.time_change_quiet).toBe(1)
    expect(db.captured.reads).toEqual([])
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('reads only unsent block-edit time changes at in-band studios, today onwards, last 48h', async () => {
    const db = makeDb({ rows: [] })
    await runShiftTimeChangeNotices(db, { nowMs: IN_BAND, locations: [LOC, { id: 'loc-x', timezone: 'Pacific/Auckland' }] })
    const calls = db.captured.reads[0]
    expect(calls).toContainEqual(['in', 'location_id', ['loc-1']])
    expect(calls).toContainEqual(['eq', 'action', 'time_changed'])
    expect(calls).toContainEqual(['eq', 'details->>source', 'block_edit'])
    expect(calls).toContainEqual(['is', 'notified_at', null])
    expect(calls).toContainEqual(['gte', 'block_date', '2026-09-29'])
    expect(calls).toContainEqual(['gte', 'created_at', '2026-09-27T10:00:00.000Z'])
  })

  it('sends shift_adjusted once per coach and stamps every row of the group on delivery', async () => {
    const db = makeDb({ rows: [row('r1'), row('r2')] })
    const s = await runShiftTimeChangeNotices(db, { nowMs: IN_BAND, locations: [LOC] })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(key).toBe('shift_time_changed:r2')
    expect(ids).toEqual(['u1'])
    expect(payload).toMatchObject({
      title: 'Shift time changed', category: 'shift_adjusted',
      data: { type: 'shift_adjusted', block_date: '2026-09-30', location_id: 'loc-1' },
    })
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['r1', 'r2'])
    expect(s.time_change_told).toBe(1)
  })

  it('opted out / deduped / failed: NOT stamped, so the re-publish safety net can still reach them', async () => {
    for (const [result, key] of [
      [{ sent: 0, skipped: 1, failed: 0, emailed: 0, deduped: 0 }, 'time_change_undelivered'],
      [{ sent: 0, skipped: 0, failed: 0, emailed: 0, deduped: 1 }, 'time_change_deduped'],
      [{ sent: 0, skipped: 0, failed: 1, emailed: 0, deduped: 0 }, 'time_change_send_failed'],
    ]) {
      vi.clearAllMocks()
      notifyUsersOnce.mockResolvedValue(result)
      const s = await runShiftTimeChangeNotices(makeDb({ rows: [row('r1')] }), { nowMs: IN_BAND, locations: [LOC] })
      expect(markChangesNotified).not.toHaveBeenCalled()
      expect(s[key]).toBe(1)
    }
  })

  it("a row it will not send is stamped with notice 'not_needed', guarded on still being unstamped", async () => {
    const r = row('r1', { shift_blocks: blockEmbed({ start_time: '09:00:00', end_time: '12:00:00' }) })
    const db = makeDb({ rows: [r] })
    const s = await runShiftTimeChangeNotices(db, { nowMs: IN_BAND, locations: [LOC] })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    const stamp = db.captured.stamps[0]
    expect(stamp.patch.details).toEqual({ ...r.details, notice: 'not_needed' })
    expect(stamp.calls).toEqual([['eq', 'id', 'r1'], ['is', 'notified_at', null]])
    expect(s.time_change_not_needed).toBe(1)
  })

  it('a failed read is reported, not thrown, and sends nothing', async () => {
    const s = await runShiftTimeChangeNotices(makeDb({ readError: { message: 'column does not exist' } }), { nowMs: IN_BAND, locations: [LOC] })
    expect(s.time_change_read_failed).toBe(1)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('one coach throwing does not stop the next', async () => {
    notifyUsersOnce.mockRejectedValueOnce(new Error('expo down'))
    const r2 = row('r2', { coach_id: 'u2', shift_blocks: blockEmbed({ shift_assignments: [{ profile_id: 'u2', status: 'scheduled' }] }) })
    const s = await runShiftTimeChangeNotices(makeDb({ rows: [row('r1'), r2] }), { nowMs: IN_BAND, locations: [LOC] })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(2)
    expect(s.time_change_send_failed).toBe(1)
    expect(s.time_change_told).toBe(1)
  })
})
