// src/lib/roster-snapshot.test.js
// SNAPSHOT.1 — the IO around roster_publish_snapshots, against a recording
// fake client. The fake answers every awaited chain through `handler(q)`,
// where q = { table, ops: [[op, ...args], …] }; a handler that throws makes
// the await reject (a dropped connection, a PostgREST 5xx).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { logError, logWarn } = await import('./log')
const { writePublishSnapshot, loadWindowBlocks, SNAPSHOT_BLOCK_PAGE } = await import('./roster-snapshot')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const ROSTER = {
  id: 'r-1', location_id: LOC, status: 'published',
  period_start: '2026-09-14', period_end: '2026-09-20',
  published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1',
}

function fakeDb(handler) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, ops: [] }
      log.push(q)
      const b = {}
      for (const op of ['select', 'insert', 'eq', 'gte', 'lte', 'in', 'order', 'range', 'limit', 'maybeSingle']) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b }
      }
      b.then = (onF, onR) => Promise.resolve().then(() => handler(q)).then(onF, onR)
      return b
    },
  }
}

const opsOf = (q, name) => q.ops.filter(([op]) => op === name)
const insertsOf = (db) => db.log.filter((q) => opsOf(q, 'insert').length > 0).map((q) => opsOf(q, 'insert')[0][1])

function block(i, over = {}) {
  return {
    id: `b${i}`, block_date: '2026-09-15', template_id: `t${i}`,
    start_time: '06:00:00', end_time: '07:00:00', min_coaches: 1, max_coaches: 2,
    shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [], ...over,
  }
}

beforeEach(() => {
  logError.mockClear()
  logWarn.mockClear()
})

describe('loadWindowBlocks', () => {
  it('pages past the 1,000-row cap in a stable order, scoped to the studio and the dates', async () => {
    const all = Array.from({ length: SNAPSHOT_BLOCK_PAGE + 1 }, (_, i) => block(i))
    const db = fakeDb((q) => {
      const [[, lo, hi]] = opsOf(q, 'range')
      return { data: all.slice(lo, hi + 1), error: null }
    })
    const { blocks, error } = await loadWindowBlocks(db, { locationId: LOC, from: '2026-09-14', to: '2026-09-20' })
    expect(error).toBeNull()
    expect(blocks).toHaveLength(SNAPSHOT_BLOCK_PAGE + 1)
    expect(db.log.map((q) => opsOf(q, 'range')[0])).toEqual([['range', 0, 999], ['range', 1000, 1999]])
    for (const q of db.log) {
      expect(q.table).toBe('shift_blocks')
      expect(q.ops).toContainEqual(['eq', 'location_id', LOC])
      expect(q.ops).toContainEqual(['gte', 'block_date', '2026-09-14'])
      expect(q.ops).toContainEqual(['lte', 'block_date', '2026-09-20'])
      expect(opsOf(q, 'order').map(([, col]) => col)).toEqual(['block_date', 'id'])
    }
  })

  it('reads the briefing (BLOCKEDIT.1) and the arrival stamp, and never a pay column', async () => {
    const db = fakeDb(() => ({ data: [], error: null }))
    await loadWindowBlocks(db, { locationId: LOC, from: '2026-09-14', to: '2026-09-20' })
    const cols = opsOf(db.log[0], 'select')[0][1]
    expect(cols).toMatch(/\bbriefing\b/)
    expect(cols).toMatch(/\barrived_at\b/)
    expect(cols).not.toMatch(/rate|salary|cost|\bnotes\b|\*/)
  })

  it('a failed page is an error, never a short roster', async () => {
    const db = fakeDb(() => ({ data: null, error: { message: 'timeout' } }))
    await expect(loadWindowBlocks(db, { locationId: LOC, from: '2026-09-14', to: '2026-09-20' }))
      .resolves.toEqual({ blocks: null, error: { message: 'timeout' } })
  })
})

describe('writePublishSnapshot', () => {
  it("reads the roster's period and inserts one snapshot row", async () => {
    const db = fakeDb((q) => {
      if (q.table === 'shift_blocks') {
        return { data: [block(1, { shift_assignments: [{ id: 'a1', profile_id: 'p1', status: 'scheduled' }] }), block(2)], error: null }
      }
      if (q.table === 'roster_publish_snapshots') return { data: null, error: null }
      throw new Error(`unexpected table ${q.table}`)
    })
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: true })
    const [row] = insertsOf(db)
    expect(insertsOf(db)).toHaveLength(1)
    expect(row).toMatchObject({
      roster_id: 'r-1', location_id: LOC, period_start: '2026-09-14', period_end: '2026-09-20',
      published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1',
      format_version: 1, block_count: 2, assignment_count: 1,
    })
    expect(row.snapshot.blocks).toHaveLength(2)
    expect(row.snapshot.blocks[0].coaches[0]).toMatchObject({ profile_id: 'p1', start: '06:00', end: '07:00' })
    expect(row.snapshot.blocks[0]).toHaveProperty('briefing_hash', null)
    const read = db.log.find((q) => q.table === 'shift_blocks')
    expect(read.ops).toContainEqual(['gte', 'block_date', '2026-09-14'])
    expect(read.ops).toContainEqual(['lte', 'block_date', '2026-09-20'])
    expect(logError).not.toHaveBeenCalled()
  })

  it('retries a failed insert once', async () => {
    let attempts = 0
    const db = fakeDb((q) => {
      if (q.table === 'shift_blocks') return { data: [block(1)], error: null }
      attempts += 1
      return attempts === 1 ? { data: null, error: { code: '57014', message: 'statement timeout' } } : { data: null, error: null }
    })
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: true })
    expect(insertsOf(db)).toHaveLength(2)
    expect(logError).not.toHaveBeenCalled()
  })

  it('a duplicate on the retry means the first attempt landed and only its answer was lost', async () => {
    let attempts = 0
    const db = fakeDb((q) => {
      if (q.table === 'shift_blocks') return { data: [block(1)], error: null }
      attempts += 1
      if (attempts === 1) throw new Error('fetch failed')
      return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "roster_publish_snapshots_roster_id_key"' } }
    })
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: true, duplicate: true })
  })

  it('two failures: logged loudly with the roster, reported, never thrown', async () => {
    const db = fakeDb((q) => (q.table === 'shift_blocks'
      ? { data: [block(1)], error: null }
      : { data: null, error: { code: '42P01', message: 'relation "public.roster_publish_snapshots" does not exist' } }))
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: false, reason: 'insert_failed' })
    expect(insertsOf(db)).toHaveLength(2)
    expect(logError).toHaveBeenCalledWith(
      'roster-snapshot',
      expect.stringMatching(/not saved/),
      expect.objectContaining({ roster_id: 'r-1', location_id: LOC }),
    )
  })

  it('a failed block read inserts nothing and logs', async () => {
    const db = fakeDb((q) => (q.table === 'shift_blocks' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }))
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: false, reason: 'read_failed' })
    expect(insertsOf(db)).toHaveLength(0)
    expect(logError).toHaveBeenCalledWith('roster-snapshot', expect.stringMatching(/block read failed/), expect.objectContaining({ roster_id: 'r-1' }))
  })

  it('an incomplete roster row is refused without a query', async () => {
    const db = fakeDb(() => { throw new Error('should not query') })
    await expect(writePublishSnapshot(db, { id: 'r-1' })).resolves.toEqual({ saved: false, reason: 'bad_roster' })
    expect(db.log).toHaveLength(0)
    expect(logError).toHaveBeenCalled()
  })

  it('falls back to now for a missing published_at rather than refusing (the column is NOT NULL)', async () => {
    const db = fakeDb((q) => (q.table === 'shift_blocks' ? { data: [], error: null } : { data: null, error: null }))
    await writePublishSnapshot(db, { ...ROSTER, published_at: null })
    expect(Number.isFinite(Date.parse(insertsOf(db)[0].published_at))).toBe(true)
  })

  it('never throws, even when the client itself throws', async () => {
    const db = { from() { throw new Error('client gone') } }
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: false, reason: 'threw' })
    expect(logError).toHaveBeenCalled()
  })
})
