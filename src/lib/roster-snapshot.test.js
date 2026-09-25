// src/lib/roster-snapshot.test.js
// SNAPSHOT.1 — the IO around roster_publish_snapshots, against a recording
// fake client. The fake answers every awaited chain through `handler(q)`,
// where q = { table, ops: [[op, ...args], …] }; a handler that throws makes
// the await reject (a dropped connection, a PostgREST 5xx).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { logError, logWarn } = await import('./log')
const { writePublishSnapshot, loadWindowBlocks, loadRosterComparison, SNAPSHOT_BLOCK_PAGE } = await import('./roster-snapshot')
const { buildPublishSnapshot } = await import('./roster-compare')

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

// ── loadRosterComparison ─────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 25, 12)

const PUBLISHED_BLOCKS = [block(1, {
  shift_assignments: [
    { id: 'a1', profile_id: 'p1', status: 'scheduled' },
    { id: 'a2', profile_id: 'p2', status: 'scheduled' },
  ],
})]

const SNAP_ROW = {
  id: 's-1', roster_id: 'r-1', location_id: LOC,
  period_start: '2026-09-14', period_end: '2026-09-20',
  published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1', format_version: 1,
  snapshot: buildPublishSnapshot({ periodStart: '2026-09-14', periodEnd: '2026-09-20', blocks: PUBLISHED_BLOCKS }).snapshot,
}

// p1 still on, p2 gone; p1's name comes from the live embed.
const LIVE_BLOCKS = [block(1, {
  shift_assignments: [{ id: 'a1', profile_id: 'p1', status: 'scheduled', arrived_at: null, profiles: { full_name: 'Coach One' } }],
})]

function compareDb({
  location = { id: LOC, timezone: 'Europe/Dublin' },
  own = SNAP_ROW,
  against = null,
  first = { published_at: SNAP_ROW.published_at },
  publishes = [SNAP_ROW],
  blocks = LIVE_BLOCKS,
  names = [{ id: 'p2', full_name: 'Coach Two' }, { id: 'mgr-1', full_name: 'Manager M' }],
  fail = {},
} = {}) {
  return fakeDb((q) => {
    const eqCols = opsOf(q, 'eq').map(([, col]) => col)
    const selected = opsOf(q, 'select')[0]?.[1]
    if (q.table === 'locations') return fail.location ? { data: null, error: fail.location } : { data: location, error: null }
    if (q.table === 'roster_publish_snapshots') {
      if (eqCols.includes('roster_id')) return fail.own ? { data: null, error: fail.own } : { data: own, error: null }
      if (eqCols.includes('id')) return { data: against, error: null }
      if (selected === 'published_at') return { data: first, error: null }
      return fail.publishes ? { data: null, error: fail.publishes } : { data: publishes, error: null }
    }
    if (q.table === 'shift_blocks') return fail.blocks ? { data: null, error: fail.blocks } : { data: blocks, error: null }
    if (q.table === 'profiles') return fail.names ? { data: null, error: fail.names } : { data: names, error: null }
    throw new Error(`unexpected table ${q.table}`)
  })
}

const ROSTER_FOR_COMPARE = { ...ROSTER }

describe('loadRosterComparison', () => {
  it("compares the roster's own snapshot with the live roster, for the window asked", async () => {
    const db = compareDb()
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, from: '2026-09-15', to: '2026-09-16', nowMs: NOW })
    expect(out.error).toBeUndefined()
    const d = out.data
    expect(d.roster).toEqual({ id: 'r-1', status: 'published', period_start: '2026-09-14', period_end: '2026-09-20', published_at: ROSTER.published_at })
    expect(d.window).toEqual({ from: '2026-09-15', to: '2026-09-16' })
    expect(d.baseline).toEqual({
      snapshot_id: 's-1', roster_id: 'r-1', published_at: SNAP_ROW.published_at,
      period_start: '2026-09-14', period_end: '2026-09-20', published_by_name: 'Manager M',
    })
    expect(d.missing_reason).toBeNull()
    expect(d.snapshots_began_at).toBe(SNAP_ROW.published_at)
    expect(d.publishes).toEqual([{ snapshot_id: 's-1', roster_id: 'r-1', published_at: SNAP_ROW.published_at, period_start: '2026-09-14', period_end: '2026-09-20' }])
    expect(d.blocks[0].coaches.map((c) => [c.name, c.change])).toEqual([['Coach One', 'unchanged'], ['Coach Two', 'removed']])
    expect(d.totals).toMatchObject({ unchanged: 1, removed: 1, published_shifts: 2, current_shifts: 1 })

    // The live read is the WINDOW, not the whole roster period.
    const live = db.log.find((q) => q.table === 'shift_blocks')
    expect(live.ops).toContainEqual(['gte', 'block_date', '2026-09-15'])
    expect(live.ops).toContainEqual(['lte', 'block_date', '2026-09-16'])
    // Names are read only for people the live embed does not already name.
    const names = db.log.find((q) => q.table === 'profiles')
    expect(opsOf(names, 'in')[0][2].sort()).toEqual(['mgr-1', 'p2'])
    // Every snapshot read is pinned to the roster's studio.
    for (const q of db.log.filter((x) => x.table === 'roster_publish_snapshots')) {
      expect(q.ops).toContainEqual(['eq', 'location_id', LOC])
    }
  })

  it('compares against another publish at the same studio when asked', async () => {
    const earlier = { ...SNAP_ROW, id: 's-0', roster_id: 'r-0', published_at: '2026-09-10T08:00:00+00:00' }
    const db = compareDb({ against: earlier })
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, againstId: 's-0', nowMs: NOW })
    expect(out.data.baseline).toMatchObject({ snapshot_id: 's-0', roster_id: 'r-0' })
    const q = db.log.find((x) => x.table === 'roster_publish_snapshots' && opsOf(x, 'eq').some(([, c]) => c === 'id'))
    expect(q.ops).toContainEqual(['eq', 'id', 's-0'])
    expect(q.ops).toContainEqual(['eq', 'location_id', LOC])
  })

  it('an against snapshot that is not at this studio (or does not exist) is not found', async () => {
    const out = await loadRosterComparison(compareDb({ against: null }), { roster: ROSTER_FOR_COMPARE, againstId: 's-x', nowMs: NOW })
    expect(out).toEqual({ notFound: true })
  })

  it('a roster published before the studio\'s first snapshot: before_snapshots, with the date, and no live read', async () => {
    const db = compareDb({ own: null, first: { published_at: '2026-09-26T08:00:00+00:00' }, publishes: [] })
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.data).toMatchObject({
      baseline: null, missing_reason: 'before_snapshots', snapshots_began_at: '2026-09-26T08:00:00+00:00',
      window: null, blocks: [], totals: null,
    })
    expect(db.log.some((q) => q.table === 'shift_blocks')).toBe(false)
  })

  it('no snapshot at the studio at all: before_snapshots, date null', async () => {
    const out = await loadRosterComparison(compareDb({ own: null, first: null, publishes: [] }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.data).toMatchObject({ missing_reason: 'before_snapshots', snapshots_began_at: null })
  })

  it('published after snapshots began but none saved: not_saved', async () => {
    const out = await loadRosterComparison(
      compareDb({ own: null, first: { published_at: '2026-09-01T08:00:00+00:00' } }),
      { roster: ROSTER_FOR_COMPARE, nowMs: NOW },
    )
    expect(out.data.missing_reason).toBe('not_saved')
  })

  it('a failed read is an error, logged, never an empty comparison', async () => {
    for (const key of ['location', 'own', 'publishes', 'blocks']) {
      logError.mockClear()
      const out = await loadRosterComparison(compareDb({ fail: { [key]: { message: `${key} down` } } }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
      expect(out.error, key).toEqual({ message: `${key} down` })
      expect(out.data, key).toBeUndefined()
      expect(logError, key).toHaveBeenCalledWith('roster-snapshot', expect.any(String), expect.objectContaining({ roster_id: 'r-1' }))
    }
  })

  it('a failed names read degrades to unknown names, logged; the comparison still answers', async () => {
    const out = await loadRosterComparison(compareDb({ fail: { names: { message: 'names down' } } }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.data.blocks[0].coaches.find((c) => c.profile_id === 'p2').name).toBeNull()
    expect(out.data.baseline.published_by_name).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })

  it('a snapshot written by newer code is refused rather than misread', async () => {
    const out = await loadRosterComparison(compareDb({ own: { ...SNAP_ROW, format_version: 2 } }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.error).toBeTruthy()
    expect(out.data).toBeUndefined()
  })

  it('a briefing edited after publish reaches the block as briefing_change, never as text', async () => {
    const own = {
      ...SNAP_ROW,
      snapshot: buildPublishSnapshot({
        periodStart: '2026-09-14', periodEnd: '2026-09-20',
        blocks: [block(1, { briefing: 'Fire drill at 10', shift_assignments: PUBLISHED_BLOCKS[0].shift_assignments })],
      }).snapshot,
    }
    const live = [{ ...LIVE_BLOCKS[0], briefing: 'Fire drill at 11' }]
    const out = await loadRosterComparison(compareDb({ own, blocks: live }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.data.blocks[0].briefing_change).toBe('changed')
    expect(out.data.totals.blocks_briefing_changed).toBe(1)
    expect(JSON.stringify(out.data)).not.toMatch(/Fire drill|briefing_hash/)
  })

  // SNAPSHOT.1 review 3 — a baseline must be a publish of THESE dates.
  it('refuses an against snapshot whose period does not overlap the roster\'s published period, before any live read', async () => {
    const elsewhere = { ...SNAP_ROW, id: 's-9', roster_id: 'r-9', period_start: '2026-10-05', period_end: '2026-10-11' }
    const db = compareDb({ against: elsewhere })
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, againstId: 's-9', nowMs: NOW })
    expect(out.data).toBeUndefined()
    expect(out.conflict).toMatch(/Mon 5 Oct – Sun 11 Oct/)
    expect(out.conflict).toMatch(/does not overlap/)
    expect(db.log.some((q) => q.table === 'shift_blocks')).toBe(false)
  })

  it("judges the overlap on the roster's OWN snapshot period, not its (possibly since shrunk) rosters row", async () => {
    // The rosters row was trimmed to 14-15 Sep by a later publish; its
    // snapshot still records 14-20 Sep, and a baseline of 18-20 Sep overlaps that.
    const shrunk = { ...ROSTER, period_end: '2026-09-15' }
    const later = { ...SNAP_ROW, id: 's-2', roster_id: 'r-2', period_start: '2026-09-18', period_end: '2026-09-20' }
    const out = await loadRosterComparison(compareDb({ against: later }), { roster: shrunk, againstId: 's-2', nowMs: NOW })
    expect(out.conflict).toBeUndefined()
    expect(out.data.baseline.snapshot_id).toBe('s-2')
  })

  it('with no snapshot of its own, the overlap is judged on the rosters row', async () => {
    const later = { ...SNAP_ROW, id: 's-2', roster_id: 'r-2', period_start: '2026-09-21', period_end: '2026-09-27' }
    const out = await loadRosterComparison(compareDb({ own: null, against: later }), { roster: ROSTER_FOR_COMPARE, againstId: 's-2', nowMs: NOW })
    expect(out.conflict).toMatch(/does not overlap/)
  })

  it('a window that misses the baseline is outside_window: the baseline named, no totals, no live read', async () => {
    const db = compareDb()
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, from: '2026-09-28', to: '2026-10-04', nowMs: NOW })
    expect(out.data).toMatchObject({
      window: null, missing_reason: 'outside_window', blocks: [], totals: null,
      baseline: { snapshot_id: 's-1', published_by_name: 'Manager M' },
    })
    expect(db.log.some((q) => q.table === 'shift_blocks')).toBe(false)
  })
})
