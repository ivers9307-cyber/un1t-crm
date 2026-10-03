// AVAIL.3 — the one-time "your unavailable days moved" notice to the people
// whose Unavailable requests the mig 703 move carried. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ sendPushOnce: vi.fn(async () => ({ sent: 1, skipped: 0, invalidated: 0, failed: 0, deduped: 0 })) }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const { sendPushOnce } = await import('./push-dedup')
const {
  AVAILABILITY_MOVE_NOTICE, moveNoticeRecipients, moveNoticeCopyProblem, runAvailabilityMoveNotice,
} = await import('./availability-move-notice')

// 3 Oct 2026 10:00 Dublin (IST, UTC+1) = 09:00Z; 23:30 Dublin = 22:30Z.
const DAY = Date.parse('2026-10-03T09:00:00Z')
const NIGHT = Date.parse('2026-10-03T22:30:00Z')

const ledger = (id, profileId, over = {}) => ({
  time_off_request_id: id, batch_id: 'batch-1', profile_id: profileId, restored_at: null,
  original: { id, location_id: 'loc-1' }, ...over,
})

function fakeDb({ rows = [], ledgerError = null, zones = [{ id: 'loc-1', timezone: 'Europe/Dublin' }] } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      const q = { table, filters: [] }
      reads.push(q)
      const b = {
        select: (s) => { q.select = s; return b },
        is: (c, v) => { q.filters.push(['is', c, v]); return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); return b },
        order: () => b,
        then: (ok, err) => {
          if (table === 'time_off_availability_moves') {
            const out = ledgerError ? { data: null, error: ledgerError }
              : { data: rows.filter((r) => q.filters.every(([op, c, v]) => (op === 'is' ? r[c] === v : r[c] === v))), error: null }
            return Promise.resolve(out).then(ok, err)
          }
          if (table === 'locations') return Promise.resolve({ data: zones, error: null }).then(ok, err)
          return Promise.resolve({ data: [], error: null }).then(ok, err)
        },
      }
      return b
    },
  }
}

beforeEach(() => { sendPushOnce.mockClear() })

describe('the copy', () => {
  it('is short, plain, says where the days are and to update the app, and has no em dash', () => {
    const { title, body } = AVAILABILITY_MOVE_NOTICE
    expect(title).toBe('Your unavailable days have moved')
    expect(body).toBe('Your unavailable days are now in My availability, on the Schedule screen. Update the Repset app to the latest version to see them.')
    expect(moveNoticeCopyProblem({ title, body })).toBeNull()
  })

  it('an operator override is checked the same way', () => {
    expect(moveNoticeCopyProblem({ title: 'Moved — see app', body: 'x' })).toMatch(/em dash/)
    expect(moveNoticeCopyProblem({ title: '', body: 'x' })).toMatch(/title/)
    expect(moveNoticeCopyProblem({ title: 'x', body: 'y'.repeat(179) })).toMatch(/178/)
  })
})

describe('moveNoticeRecipients (pure)', () => {
  it('one per person, from un-restored ledger rows, with the studio of their first request', () => {
    const out = moveNoticeRecipients([
      ledger('t1', 'p1'),
      ledger('t2', 'p1', { original: { id: 't2', location_id: 'loc-2' } }),
      ledger('t3', 'p2'),
      ledger('t4', 'p3', { restored_at: '2026-10-04T00:00:00Z' }),
    ])
    expect(out).toEqual([{ profileId: 'p1', locationId: 'loc-1' }, { profileId: 'p2', locationId: 'loc-1' }])
  })
})

describe('runAvailabilityMoveNotice', () => {
  it('a preview sends nothing and says how many would be told (counts only)', async () => {
    const db = fakeDb({ rows: [ledger('t1', 'p1'), ledger('t2', 'p2')] })
    const out = await runAvailabilityMoveNotice(db, { nowMs: DAY })
    expect(out).toEqual({ ok: true, send: false, recipients: 2, inHours: 2, deferred: 0, title: AVAILABILITY_MOVE_NOTICE.title, body: AVAILABILITY_MOVE_NOTICE.body })
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('sends one categoryless push per person, once ever (a stable key per person)', async () => {
    const db = fakeDb({ rows: [ledger('t1', 'p1'), ledger('t2', 'p1'), ledger('t3', 'p2')] })
    const out = await runAvailabilityMoveNotice(db, { nowMs: DAY, send: true })
    expect(out).toMatchObject({ ok: true, send: true, recipients: 2, sent: 2, deferred: 0 })
    expect(sendPushOnce.mock.calls.map(([, key, ids]) => [key, ids])).toEqual([
      ['availability_moved:p1', ['p1']], ['availability_moved:p2', ['p2']],
    ])
    const payload = sendPushOnce.mock.calls[0][3]
    expect(payload).toEqual({ title: AVAILABILITY_MOVE_NOTICE.title, body: AVAILABILITY_MOVE_NOTICE.body, data: { type: 'availability_moved' } })
    expect('category' in payload).toBe(false)
  })

  it('quiet hours gate the NOTICE: outside 07:00-22:00 at the studio nothing is sent, and a later run sends', async () => {
    const db = fakeDb({ rows: [ledger('t1', 'p1')] })
    const night = await runAvailabilityMoveNotice(db, { nowMs: NIGHT, send: true })
    expect(night).toMatchObject({ ok: true, recipients: 1, sent: 0, deferred: 1 })
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('reads one batch when asked, never restored rows', async () => {
    const db = fakeDb({ rows: [ledger('t1', 'p1'), ledger('t2', 'p2', { batch_id: 'batch-2' })] })
    const out = await runAvailabilityMoveNotice(db, { nowMs: DAY, batchId: 'batch-2' })
    expect(out.recipients).toBe(1)
    const read = db.reads.find((q) => q.table === 'time_off_availability_moves')
    expect(read.filters).toEqual(expect.arrayContaining([['is', 'restored_at', null], ['eq', 'batch_id', 'batch-2']]))
  })

  it('an unreadable ledger is an error, never "nobody to tell"', async () => {
    const out = await runAvailabilityMoveNotice(fakeDb({ ledgerError: { message: 'down' } }), { nowMs: DAY, send: true })
    expect(out).toEqual({ ok: false, error: 'down' })
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('refuses copy that breaks the rules, before any read', async () => {
    const db = fakeDb({ rows: [ledger('t1', 'p1')] })
    const out = await runAvailabilityMoveNotice(db, { nowMs: DAY, send: true, title: 'A — B' })
    expect(out.ok).toBe(false)
    expect(db.reads).toEqual([])
  })
})
