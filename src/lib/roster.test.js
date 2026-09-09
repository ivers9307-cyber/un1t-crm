// Roster v2 lib tests — block generation, day-code mapping, and
// the unstaffed-future predicate that drives the calendar's red
// flag.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  WEEKDAY_CODES,
  dayCodeForDate,
  getMonday,
  formatDate,
  expandDaysToDates,
  generateBlocksForTemplate,
  isBlockUnstaffedFuture,
  isLiveAssignment,
  liveAssignments,
  findPublishedRosterFor,
  findPublishedRosterIdsByDate,
  getMonthStart,
  monthStartForWeek,
  weekStartForMonth,
} from './roster'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
import { logWarn } from '@/lib/log'

// ROSTER-FIX.5 — a thenable rosters-query builder. Every filter method
// returns the builder; awaiting it (or calling maybeSingle) resolves to the
// supabase envelope. Mirrors the mock pattern used in report-generator.test.
function rostersBuilder(result) {
  const b = {
    calls: [],
    select: (...a) => { b.calls.push(['select', ...a]); return b },
    eq: (...a) => { b.calls.push(['eq', ...a]); return b },
    lte: (...a) => { b.calls.push(['lte', ...a]); return b },
    gte: (...a) => { b.calls.push(['gte', ...a]); return b },
    order: (...a) => { b.calls.push(['order', ...a]); return b },
    limit: (...a) => { b.calls.push(['limit', ...a]); return b },
    maybeSingle: () => Promise.resolve(result),
    then: (ok, err) => Promise.resolve(result).then(ok, err),
  }
  return b
}

// ROSTER-FIX.5 — a rosters mock that actually filters, orders and limits a
// fixture, so the overlap tests exercise the real ordering instead of a
// hand-picked row. `honourOrder: false` hands the rows back untouched, which
// is how we prove the batched matcher's own tie-break does the work.
function rostersFixtureDb(rows, { honourOrder = true } = {}) {
  function build() {
    const state = { rows: rows.slice(), orders: [], limit: null }
    const b = {
      select: () => b,
      eq: () => b,
      lte: (col, val) => { state.rows = state.rows.filter(r => r[col] <= val); return b },
      gte: (col, val) => { state.rows = state.rows.filter(r => r[col] >= val); return b },
      order: (col, opts = {}) => { state.orders.push([col, opts.ascending !== false]); return b },
      limit: (n) => { state.limit = n; return b },
      _settle: () => {
        const sorted = state.rows.slice()
        if (honourOrder) {
          sorted.sort((x, y) => {
            for (const [col, asc] of state.orders) {
              const a = String(x[col] ?? '')
              const c = String(y[col] ?? '')
              if (a !== c) return (a < c ? -1 : 1) * (asc ? 1 : -1)
            }
            return 0
          })
        }
        return state.limit != null ? sorted.slice(0, state.limit) : sorted
      },
      maybeSingle: () => Promise.resolve({ data: b._settle()[0] ?? null, error: null }),
      then: (ok, err) => Promise.resolve({ data: b._settle(), error: null }).then(ok, err),
    }
    return b
  }
  return { from: vi.fn(() => build()) }
}

describe('dayCodeForDate', () => {
  it('returns mon for a Monday', () => {
    // 2026-05-04 is a Monday.
    expect(dayCodeForDate('2026-05-04')).toBe('mon')
  })
  it('returns sun for a Sunday', () => {
    // 2026-05-03 is a Sunday.
    expect(dayCodeForDate('2026-05-03')).toBe('sun')
  })
  it('handles all 7 weekdays in order', () => {
    const codes = []
    for (let i = 4; i <= 10; i++) {
      codes.push(dayCodeForDate(`2026-05-0${i}`))
    }
    expect(codes).toEqual(WEEKDAY_CODES)
  })
})

describe('getMonday', () => {
  it('returns the same date if input is Monday', () => {
    const d = getMonday(new Date('2026-05-04T12:00:00'))
    expect(formatDate(d)).toBe('2026-05-04')
  })
  it('rolls back from a Wednesday', () => {
    const d = getMonday(new Date('2026-05-06T12:00:00'))
    expect(formatDate(d)).toBe('2026-05-04')
  })
  it('rolls back from a Sunday (week starts Monday)', () => {
    const d = getMonday(new Date('2026-05-03T12:00:00'))
    expect(formatDate(d)).toBe('2026-04-27')
  })
})

describe('expandDaysToDates', () => {
  it('returns mon/wed/fri dates over a 2-week window', () => {
    const dates = expandDaysToDates(
      ['mon', 'wed', 'fri'],
      '2026-05-04', // Mon
      '2026-05-17'  // Sun
    )
    expect(dates).toEqual([
      '2026-05-04', '2026-05-06', '2026-05-08',
      '2026-05-11', '2026-05-13', '2026-05-15',
    ])
  })
  it('returns empty array if no day codes match', () => {
    expect(expandDaysToDates([], '2026-05-04', '2026-05-10')).toEqual([])
  })
  it('handles weekend-only templates', () => {
    const dates = expandDaysToDates(
      ['sat', 'sun'],
      '2026-05-04',
      '2026-05-17'
    )
    expect(dates).toEqual([
      '2026-05-09', '2026-05-10', '2026-05-16', '2026-05-17',
    ])
  })
  it('inclusive on both ends — 1-day window matching', () => {
    expect(expandDaysToDates(['mon'], '2026-05-04', '2026-05-04'))
      .toEqual(['2026-05-04'])
  })
})

describe('generateBlocksForTemplate', () => {
  let upsertMock
  let fromMock
  let db
  let rostersResult

  beforeEach(() => {
    vi.clearAllMocks()
    upsertMock = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({
        // Pretend everything inserted (3 weeks × Mon/Wed/Fri = ~24).
        data: Array(24).fill(0).map((_, i) => ({ id: `block-${i}` })),
        error: null,
      }),
    })
    // ROSTER-FIX.5 — the generator now asks `rosters` which published
    // roster covers each date, so the mock has to dispatch per table.
    rostersResult = { data: [], error: null }
    fromMock = vi.fn((table) => (
      table === 'rosters' ? rostersBuilder(rostersResult) : { upsert: upsertMock }
    ))
    db = { from: fromMock }
  })

  it('no-ops when days_of_week is empty', async () => {
    const result = await generateBlocksForTemplate(db, {
      id: 't1', location_id: 'l1',
      start_time: '09:30', end_time: '10:30',
      days_of_week: [], max_coaches: 15,
    })
    expect(result).toEqual({ inserted: 0, skipped: 0 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('issues an upsert with one record per matching date', async () => {
    await generateBlocksForTemplate(
      db,
      {
        id: 't1', location_id: 'l1',
        start_time: '09:30', end_time: '10:30',
        days_of_week: ['mon', 'wed', 'fri'],
        max_coaches: 15,
      },
      '2026-05-04', // start
      4              // 4 weeks → 12 blocks (Mon/Wed/Fri × 4)
    )

    expect(fromMock).toHaveBeenCalledWith('shift_blocks')
    const calls = upsertMock.mock.calls[0]
    const records = calls[0]
    expect(records).toHaveLength(12) // 3 days/week × 4 weeks

    // First record should be the first matching date in the window.
    expect(records[0]).toMatchObject({
      location_id: 'l1',
      template_id: 't1',
      block_date: '2026-05-04',
      start_time: '09:30',
      end_time: '10:30',
      max_coaches: 15,
    })

    // Conflict policy must keep us idempotent — re-running the
    // generator with the same inputs shouldn't error or duplicate.
    expect(calls[1]).toMatchObject({
      onConflict: 'location_id,template_id,block_date',
      ignoreDuplicates: true,
    })
  })

  it('defaults max_coaches to 15 when missing on template', async () => {
    await generateBlocksForTemplate(
      db,
      {
        id: 't2', location_id: 'l1',
        start_time: '06:00', end_time: '07:00',
        days_of_week: ['mon'],
        // max_coaches intentionally missing
      },
      '2026-05-04',
      1
    )
    const records = upsertMock.mock.calls[0][0]
    expect(records[0].max_coaches).toBe(15)
  })

  it('throws when supabase reports an error', async () => {
    const errUpsert = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'unique violation' },
      }),
    })
    const errDb = { from: vi.fn((table) => (
      table === 'rosters' ? rostersBuilder({ data: [], error: null }) : { upsert: errUpsert }
    )) }

    await expect(
      generateBlocksForTemplate(errDb, {
        id: 't1', location_id: 'l1',
        start_time: '09:30', end_time: '10:30',
        days_of_week: ['mon'],
        max_coaches: 15,
      }, '2026-05-04', 1)
    ).rejects.toThrow(/unique violation/)
  })
})

describe('isBlockUnstaffedFuture', () => {
  const now = new Date('2026-05-04T12:00:00')

  it('flags an empty future block', () => {
    expect(
      isBlockUnstaffedFuture({ block_date: '2026-05-10' }, 0, now)
    ).toBe(true)
  })

  it('flags an empty block on today', () => {
    expect(
      isBlockUnstaffedFuture({ block_date: '2026-05-04' }, 0, now)
    ).toBe(true)
  })

  it('does NOT flag a past empty block — those are noise', () => {
    expect(
      isBlockUnstaffedFuture({ block_date: '2026-04-30' }, 0, now)
    ).toBe(false)
  })

  it('does NOT flag a future block with at least one assignment', () => {
    expect(
      isBlockUnstaffedFuture({ block_date: '2026-05-10' }, 1, now)
    ).toBe(false)
  })
})

describe('isLiveAssignment', () => {
  it('treats scheduled / confirmed / completed / swapped as live', () => {
    for (const status of ['scheduled', 'confirmed', 'completed', 'swapped']) {
      expect(isLiveAssignment({ status })).toBe(true)
    }
  })
  it('treats cancelled as not live', () => {
    expect(isLiveAssignment({ status: 'cancelled' })).toBe(false)
  })
  it('treats a missing status as live (legacy rows)', () => {
    expect(isLiveAssignment({})).toBe(true)
    expect(isLiveAssignment({ status: null })).toBe(true)
  })
  it('liveAssignments filters an array and tolerates null', () => {
    expect(liveAssignments(null)).toEqual([])
    expect(liveAssignments([{ status: 'cancelled' }, { status: 'scheduled', id: 'a' }])).toEqual([{ status: 'scheduled', id: 'a' }])
  })
})

// ─── ROSTER-FIX.5 — blocks join the published roster they land inside ───────

describe('findPublishedRosterFor', () => {
  it('returns the id of the published roster covering the date', async () => {
    const builder = rostersBuilder({ data: { id: 'r1' }, error: null })
    const db = { from: vi.fn(() => builder) }
    expect(await findPublishedRosterFor(db, 'loc1', '2026-05-06')).toBe('r1')
    expect(db.from).toHaveBeenCalledWith('rosters')
    // The filters ARE the contract: same location, published only, and the
    // date inside the inclusive period.
    expect(builder.calls).toEqual([
      ['select', 'id, published_at, created_at'],
      ['eq', 'location_id', 'loc1'],
      ['eq', 'status', 'published'],
      ['lte', 'period_start', '2026-05-06'],
      ['gte', 'period_end', '2026-05-06'],
      // ROSTER-FIX.5 — an unordered .limit(1) over two overlapping published
      // rosters returns whichever row Postgres reached first. The most
      // recently PUBLISHED one wins; period_start would pick the week a
      // later month publish has already superseded.
      ['order', 'published_at', { ascending: false, nullsFirst: false }],
      ['order', 'created_at', { ascending: false }],
      ['limit', 1],
    ])
  })

  it('returns null when no published roster covers the date', async () => {
    const db = { from: vi.fn(() => rostersBuilder({ data: null, error: null })) }
    expect(await findPublishedRosterFor(db, 'loc1', '2026-05-06')).toBeNull()
  })

  it('returns null and warns when the query errors — never throws', async () => {
    const db = { from: vi.fn(() => rostersBuilder({ data: null, error: { message: 'boom' } })) }
    expect(await findPublishedRosterFor(db, 'loc1', '2026-05-06')).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })

  it('returns null without querying when location or date is missing', async () => {
    const db = { from: vi.fn() }
    expect(await findPublishedRosterFor(db, null, '2026-05-06')).toBeNull()
    expect(await findPublishedRosterFor(db, 'loc1', null)).toBeNull()
    expect(db.from).not.toHaveBeenCalled()
  })
})

describe('findPublishedRosterIdsByDate', () => {
  it('resolves many dates with ONE query spanning min..max', async () => {
    const builder = rostersBuilder({
      data: [
        { id: 'rA', period_start: '2026-05-04', period_end: '2026-05-10' },
        { id: 'rB', period_start: '2026-05-11', period_end: '2026-05-17' },
      ],
      error: null,
    })
    const db = { from: vi.fn(() => builder) }
    const map = await findPublishedRosterIdsByDate(db, 'loc1', ['2026-05-04', '2026-05-13', '2026-05-25'])

    expect(db.from).toHaveBeenCalledTimes(1)
    expect(builder.calls).toEqual([
      ['select', 'id, period_start, period_end, published_at, created_at'],
      ['eq', 'location_id', 'loc1'],
      ['eq', 'status', 'published'],
      ['lte', 'period_start', '2026-05-25'],
      ['gte', 'period_end', '2026-05-04'],
      ['order', 'published_at', { ascending: false, nullsFirst: false }],
      ['order', 'created_at', { ascending: false }],
    ])
    expect(map.get('2026-05-04')).toBe('rA')
    expect(map.get('2026-05-13')).toBe('rB')
    // Nothing published covers this one — stays untagged, not mis-tagged.
    expect(map.get('2026-05-25')).toBeUndefined()
  })

  it('spans the true min/max even when dates arrive unsorted', async () => {
    const builder = rostersBuilder({ data: [], error: null })
    const db = { from: vi.fn(() => builder) }
    await findPublishedRosterIdsByDate(db, 'loc1', ['2026-05-20', '2026-05-04', '2026-05-11'])
    expect(builder.calls).toContainEqual(['lte', 'period_start', '2026-05-20'])
    expect(builder.calls).toContainEqual(['gte', 'period_end', '2026-05-04'])
  })

  it('returns an empty map and warns on error — block generation must survive', async () => {
    const db = { from: vi.fn(() => rostersBuilder({ data: null, error: { message: 'boom' } })) }
    const map = await findPublishedRosterIdsByDate(db, 'loc1', ['2026-05-04'])
    expect(map.size).toBe(0)
    expect(logWarn).toHaveBeenCalled()
  })

  it('does not query for an empty date list', async () => {
    const db = { from: vi.fn() }
    expect((await findPublishedRosterIdsByDate(db, 'loc1', [])).size).toBe(0)
    expect(db.from).not.toHaveBeenCalled()
  })
})

// ─── ROSTER-FIX.5 — overlapping published rosters resolve deterministically ──
//
// Nothing in the schema stops two published rosters covering the same day: a
// re-cut week published beside the one it replaces, and — the case that broke
// the first cut of this — a WIDER period published over ones it contains.
// The rule is that the most recently PUBLISHED roster wins. Not the latest
// period_start, and not the most recently created row.

describe('two published rosters covering one date', () => {
  const DATE = '2026-05-06'

  // The real case. The week 05-04..05-10 was published, then the whole month
  // 05-01..05-31 was published over it — and that month publish re-tagged
  // every block inside it. So a block created afterwards for 05-06 belongs to
  // the MONTH, even though the WEEK has BOTH the later period_start and the
  // later created_at. Only published_at gets this right.
  const WEEK_THEN_MONTH = [
    { id: 'r-week', period_start: '2026-05-04', period_end: '2026-05-10', published_at: '2026-05-01T10:00:00Z', created_at: '2026-04-25T00:00:00Z' },
    { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31', published_at: '2026-05-02T10:00:00Z', created_at: '2026-04-01T00:00:00Z' },
  ]

  // The reverse: the month went out first, then one week inside it was re-cut
  // and published over the top. Now the WEEK is the live roster for 05-06 —
  // even though the month is the more recently CREATED row.
  const MONTH_THEN_WEEK = [
    { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31', published_at: '2026-05-01T10:00:00Z', created_at: '2026-04-30T00:00:00Z' },
    { id: 'r-week', period_start: '2026-05-04', period_end: '2026-05-10', published_at: '2026-05-02T10:00:00Z', created_at: '2026-04-20T00:00:00Z' },
  ]

  // Row order out of the DB must not change the answer, so every case runs
  // both ways round.
  const BOTH_ORDERS = rows => [['as listed', rows], ['reversed', [...rows].reverse()]]

  for (const [order, rows] of BOTH_ORDERS(WEEK_THEN_MONTH)) {
    it(`the month published over the week wins — rows ${order}`, async () => {
      const single = await findPublishedRosterFor(rostersFixtureDb(rows), 'loc1', DATE)
      const batched = await findPublishedRosterIdsByDate(rostersFixtureDb(rows), 'loc1', [DATE])
      expect(single).toBe('r-month')
      expect(batched.get(DATE)).toBe('r-month')
      expect(batched.get(DATE)).toBe(single)
    })
  }

  for (const [order, rows] of BOTH_ORDERS(MONTH_THEN_WEEK)) {
    it(`the week re-cut after the month wins — rows ${order}`, async () => {
      const single = await findPublishedRosterFor(rostersFixtureDb(rows), 'loc1', DATE)
      const batched = await findPublishedRosterIdsByDate(rostersFixtureDb(rows), 'loc1', [DATE])
      expect(single).toBe('r-week')
      expect(batched.get(DATE)).toBe('r-week')
      expect(batched.get(DATE)).toBe(single)
    })
  }

  it('the batched matcher does not lean on the row order it was handed', async () => {
    // A DB that ignores the ORDER BY entirely: the JS tie-break is all there
    // is, and it still has to land on the same roster.
    const db = rostersFixtureDb([...WEEK_THEN_MONTH].reverse(), { honourOrder: false })
    const map = await findPublishedRosterIdsByDate(db, 'loc1', [DATE])
    expect(map.get(DATE)).toBe('r-month')
  })

  // published_at is nullable (mig 072) — a roster flipped to published before
  // that column existed carries none. Such a row is ranked on its created_at
  // rather than dropping out of the comparison.
  it('a roster with no published_at is ranked on its created_at', async () => {
    const rows = [
      { id: 'r-unstamped', period_start: '2026-05-04', period_end: '2026-05-10', published_at: null, created_at: '2026-05-01T00:00:00Z' },
      { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31', published_at: '2026-05-02T10:00:00Z', created_at: '2026-04-01T00:00:00Z' },
    ]
    const single = await findPublishedRosterFor(rostersFixtureDb(rows), 'loc1', DATE)
    const batched = await findPublishedRosterIdsByDate(rostersFixtureDb(rows), 'loc1', [DATE])
    // 05-01 (the unstamped row's created_at) loses to the 05-02 publish.
    expect(single).toBe('r-month')
    expect(batched.get(DATE)).toBe('r-month')
  })

  it('an unstamped roster still wins on a later created_at', async () => {
    // The ORDER BY sorts nulls LAST, so the query alone would hand back the
    // stamped row first; the matcher's published_at ?? created_at coalesce is
    // what keeps the newer roster.
    const rows = [
      { id: 'r-unstamped', period_start: '2026-05-04', period_end: '2026-05-10', published_at: null, created_at: '2026-05-09T00:00:00Z' },
      { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31', published_at: '2026-05-02T10:00:00Z', created_at: '2026-04-01T00:00:00Z' },
    ]
    const batched = await findPublishedRosterIdsByDate(rostersFixtureDb(rows), 'loc1', [DATE])
    expect(batched.get(DATE)).toBe('r-unstamped')
  })
})

describe('generateBlocksForTemplate → roster_id', () => {
  let upsertMock
  let db
  let rostersResult

  beforeEach(() => {
    vi.clearAllMocks()
    upsertMock = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: [{ id: 'b1' }], error: null }),
    })
    rostersResult = { data: [], error: null }
    db = {
      from: vi.fn((table) => (
        table === 'rosters' ? rostersBuilder(rostersResult) : { upsert: upsertMock }
      )),
    }
  })

  const tpl = {
    id: 't1', location_id: 'l1',
    start_time: '09:30', end_time: '10:30',
    days_of_week: ['mon'], max_coaches: 15,
  }

  it('tags a new block with the published roster covering its date', async () => {
    rostersResult = { data: [{ id: 'rA', period_start: '2026-05-04', period_end: '2026-05-10' }], error: null }
    await generateBlocksForTemplate(db, tpl, '2026-05-04', 3)
    const records = upsertMock.mock.calls[0][0]
    // 2026-05-04 sits inside rA; 05-11 and 05-18 do not.
    expect(records.map(r => [r.block_date, r.roster_id])).toEqual([
      ['2026-05-04', 'rA'],
      ['2026-05-11', null],
      ['2026-05-18', null],
    ])
  })

  it('leaves roster_id null when nothing is published for the window', async () => {
    await generateBlocksForTemplate(db, tpl, '2026-05-04', 1)
    expect(upsertMock.mock.calls[0][0][0].roster_id).toBeNull()
  })

  it('asks rosters exactly once no matter how many dates', async () => {
    await generateBlocksForTemplate(db, tpl, '2026-05-04', 8)
    expect(db.from.mock.calls.filter(c => c[0] === 'rosters')).toHaveLength(1)
  })

  it('still generates blocks when the roster lookup errors', async () => {
    rostersResult = { data: null, error: { message: 'boom' } }
    const result = await generateBlocksForTemplate(db, tpl, '2026-05-04', 1)
    expect(result.inserted).toBe(1)
    expect(upsertMock.mock.calls[0][0][0].roster_id).toBeNull()
  })
})

// ROSTER-FIX.6a — the calendar's Month/Week toggle used to throw a month
// away. Month took getMonthStart(weekStart), so the week 27 Jul – 2 Aug
// (whose Monday is in July) landed on July when the operator was clearly
// looking at August; Week took getMonday(monthStart), so August 2026 (which
// starts on a Saturday) landed on 27 July and the very next Month click read
// July. Both directions now agree on one rule — the week belongs to the month
// its MIDWEEK day falls in — which is what makes the toggle round-trip.
describe('monthStartForWeek / weekStartForMonth (ROSTER-FIX.6a)', () => {
  const local = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }

  it('picks the month holding the midweek day, not the Monday', () => {
    // 27 Jul – 2 Aug 2026: Monday is July, midweek (Thu 30 Jul) is July.
    expect(formatDate(monthStartForWeek(local('2026-07-27')))).toBe('2026-07-01')
    // 3 – 9 Aug 2026: midweek Thu 6 Aug.
    expect(formatDate(monthStartForWeek(local('2026-08-03')))).toBe('2026-08-01')
    // 31 Aug – 6 Sep 2026: Monday is August, midweek (Thu 3 Sep) is September.
    expect(formatDate(monthStartForWeek(local('2026-08-31')))).toBe('2026-09-01')
  })

  it('keeps the visible week when it already belongs to the month', () => {
    expect(formatDate(weekStartForMonth(local('2026-07-01'), local('2026-07-27')))).toBe('2026-07-27')
  })

  it('lands on the first week of the month when the visible week is elsewhere', () => {
    expect(formatDate(weekStartForMonth(local('2026-06-01'), local('2026-09-14')))).toBe('2026-06-01')
  })

  it('round-trips a month that starts on a weekend (Aug 2026, a Saturday)', () => {
    // The bug: Week gave 27 Jul, whose midweek is July, so Month read July.
    const week = weekStartForMonth(local('2026-08-01'), local('2026-12-07'))
    expect(formatDate(week)).toBe('2026-08-03')
    expect(formatDate(monthStartForWeek(week))).toBe('2026-08-01')
  })

  it('round-trips a month that starts on a Sunday (Nov 2026)', () => {
    const week = weekStartForMonth(local('2026-11-01'), null)
    expect(formatDate(monthStartForWeek(week))).toBe('2026-11-01')
  })

  it('round-trips every month start of 2026 in both directions', () => {
    for (let m = 0; m < 12; m++) {
      const ms = new Date(2026, m, 1)
      const week = weekStartForMonth(ms, null)
      expect(formatDate(monthStartForWeek(week))).toBe(formatDate(ms))
    }
  })

  it('normalises a mid-month date to the first of its month', () => {
    expect(formatDate(getMonthStart(local('2026-08-19')))).toBe('2026-08-01')
  })
})
