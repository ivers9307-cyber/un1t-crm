import { describe, it, expect, vi } from 'vitest'
import {
  staffingStatus,
  futureBlockStaffing,
  staffingGaps,
  countStaffingGaps,
  staffingGapsHeadline,
  staffingGapsBreakdown,
  fetchStaffingGapsThisWeek,
  periodPublicationStatus,
  PUBLICATION_LABELS,
} from './roster-staffing'

const live = (profile_id) => ({ profile_id, status: 'scheduled' })
const cancelled = (profile_id) => ({ profile_id, status: 'cancelled' })
const block = (over = {}) => ({
  id: 'b', block_date: '2026-09-18', start_time: '09:00:00', min_coaches: 2, shift_assignments: [], ...over,
})

describe('staffingStatus', () => {
  it('empty at zero coaches, whatever the minimum', () => {
    expect(staffingStatus(0, 2)).toBe('empty')
    expect(staffingStatus(0, 0)).toBe('empty')
    expect(staffingStatus(0, null)).toBe('empty')
  })
  it('short when some coaches but fewer than min_coaches', () => {
    expect(staffingStatus(1, 2)).toBe('short')
    expect(staffingStatus(2, 3)).toBe('short')
  })
  it('ok at or above the minimum', () => {
    expect(staffingStatus(2, 2)).toBe('ok')
    expect(staffingStatus(3, 2)).toBe('ok')
  })
  it('a missing minimum means no minimum (the coach feed carries none)', () => {
    expect(staffingStatus(1, undefined)).toBe('ok')
    expect(staffingStatus(1, null)).toBe('ok')
    expect(staffingStatus(1, 0)).toBe('ok')
  })
})

describe('futureBlockStaffing', () => {
  it('counts LIVE assignments only — a cancelled row is not a coach', () => {
    const b = block({ shift_assignments: [live('a'), cancelled('b')] })
    expect(futureBlockStaffing(b, '2026-09-17')).toEqual({ status: 'short', count: 1, min: 2 })
    const onlyCancelled = block({ shift_assignments: [cancelled('a'), cancelled('b')] })
    expect(futureBlockStaffing(onlyCancelled, '2026-09-17').status).toBe('empty')
  })
  it('flags today, not the past', () => {
    expect(futureBlockStaffing(block({ block_date: '2026-09-17' }), '2026-09-17').status).toBe('empty')
    expect(futureBlockStaffing(block({ block_date: '2026-09-16' }), '2026-09-17')).toBeNull()
  })
  it('null without a date or a today', () => {
    expect(futureBlockStaffing(null, '2026-09-17')).toBeNull()
    expect(futureBlockStaffing(block(), undefined)).toBeNull()
  })
})

describe('staffingGaps / countStaffingGaps', () => {
  const blocks = [
    block({ id: 'short', block_date: '2026-09-19', start_time: '07:00:00', shift_assignments: [live('a')] }),
    block({ id: 'empty-late', block_date: '2026-09-18', start_time: '18:00:00' }),
    block({ id: 'empty-early', block_date: '2026-09-18', start_time: '06:00:00' }),
    block({ id: 'ok', block_date: '2026-09-18', shift_assignments: [live('a'), live('b')] }),
    block({ id: 'past', block_date: '2026-09-10' }),
    block({ id: 'next-week', block_date: '2026-09-25' }),
  ]

  it('returns empty + short future blocks in date then time order', () => {
    expect(staffingGaps(blocks, { todayIso: '2026-09-17' }).map((g) => g.block.id))
      .toEqual(['empty-early', 'empty-late', 'short', 'next-week'])
  })
  it('honours an inclusive from/to window', () => {
    expect(staffingGaps(blocks, { from: '2026-09-14', to: '2026-09-20', todayIso: '2026-09-17' }).map((g) => g.block.id))
      .toEqual(['empty-early', 'empty-late', 'short'])
  })
  it('counts both kinds', () => {
    expect(countStaffingGaps(blocks, { from: '2026-09-14', to: '2026-09-20', todayIso: '2026-09-17' }))
      .toEqual({ empty: 2, short: 1, total: 3 })
    expect(countStaffingGaps([], { todayIso: '2026-09-17' })).toEqual({ empty: 0, short: 0, total: 0 })
  })
  it('the live 2026-09-17 shape: 5 shifts at 1 of 2, 4 empty consultations', () => {
    const live17 = [
      ...Array.from({ length: 5 }, (_, i) => block({ id: `s${i}`, shift_assignments: [live('a')] })),
      ...Array.from({ length: 4 }, (_, i) => block({ id: `c${i}`, min_coaches: 1 })),
    ]
    expect(countStaffingGaps(live17, { todayIso: '2026-09-17' })).toEqual({ empty: 4, short: 5, total: 9 })
  })
})

describe('headline + breakdown copy', () => {
  it('pluralises', () => {
    expect(staffingGapsHeadline({ total: 1 })).toBe('1 shift needs coaches this week')
    expect(staffingGapsHeadline({ total: 3 })).toBe('3 shifts need coaches this week')
  })
  it('names only the kinds present', () => {
    expect(staffingGapsBreakdown({ empty: 2, short: 0 })).toBe('2 with no coach')
    expect(staffingGapsBreakdown({ empty: 0, short: 5 })).toBe('5 below the minimum')
    expect(staffingGapsBreakdown({ empty: 4, short: 5 })).toBe('4 with no coach, 5 below the minimum')
  })
})

describe('fetchStaffingGapsThisWeek', () => {
  function makeDb(rows, error = null) {
    const calls = {}
    const chain = {
      select: vi.fn((s) => { calls.select = s; return chain }),
      in: vi.fn((c, v) => { calls.in = [c, v]; return chain }),
      gte: vi.fn((c, v) => { calls.gte = [c, v]; return chain }),
      lte: vi.fn((c, v) => { calls.lte = [c, v]; return Promise.resolve({ data: rows, error }) }),
    }
    return { db: { from: vi.fn(() => chain) }, calls }
  }

  it('reads today → Sunday across the locations and counts short as well as empty', async () => {
    const { db, calls } = makeDb([
      block({ block_date: '2026-09-18', shift_assignments: [live('a')] }),
      block({ block_date: '2026-09-19' }),
      block({ block_date: '2026-09-20', shift_assignments: [live('a'), live('b')] }),
    ])
    // Thursday 17 Sep 2026 → Sunday 20 Sep.
    const res = await fetchStaffingGapsThisWeek(db, ['loc-1'], { todayIso: '2026-09-17' })
    expect(res).toEqual({ success: true, data: { empty: 1, short: 1, total: 2 } })
    expect(calls.in).toEqual(['location_id', ['loc-1']])
    expect(calls.gte).toEqual(['block_date', '2026-09-17'])
    expect(calls.lte).toEqual(['block_date', '2026-09-20'])
    expect(calls.select).toMatch(/min_coaches/)
    expect(calls.select).toMatch(/shift_assignments\(profile_id, status\)/)
  })

  it('on a Sunday the week ends today', async () => {
    const { db, calls } = makeDb([])
    await fetchStaffingGapsThisWeek(db, ['loc-1'], { todayIso: '2026-09-20' })
    expect(calls.lte).toEqual(['block_date', '2026-09-20'])
  })

  it('no locations → zero, no query', async () => {
    const { db } = makeDb([])
    expect(await fetchStaffingGapsThisWeek(db, [], { todayIso: '2026-09-17' }))
      .toEqual({ success: true, data: { empty: 0, short: 0, total: 0 } })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('a failed read is a failure, not a zero', async () => {
    const { db } = makeDb(null, { message: 'boom' })
    expect(await fetchStaffingGapsThisWeek(db, ['loc-1'], { todayIso: '2026-09-17' }))
      .toEqual({ success: false, error: 'boom' })
  })
})

describe('periodPublicationStatus', () => {
  const pub = { status: 'published' }
  const b = (date, rosters = null) => ({ block_date: date, rosters })
  const period = { periodStart: '2026-09-14', periodEnd: '2026-09-20' }

  it('published when every block in the period is on a published roster', () => {
    const r = periodPublicationStatus({ ...period, blocks: [b('2026-09-14', pub), b('2026-09-20', pub), b('2026-09-21')] })
    expect(r).toEqual({ status: 'published', draftPending: false, blockCount: 2, publishedCount: 2 })
    expect(PUBLICATION_LABELS[r.status]).toBe('Published')
  })

  it('not published when no block is', () => {
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15'), b('2026-09-16')] }).status).toBe('unpublished')
  })

  it('partly published on a mix', () => {
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15', pub), b('2026-09-16')] }).status).toBe('partial')
  })

  it('a superseded roster is not published (the coach feed hides it too)', () => {
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15', { status: 'superseded' })] }).status).toBe('unpublished')
  })

  it('pending when an overlapping draft roster awaits approval — drafts do not tag blocks', () => {
    const draftRosters = [{ status: 'draft', period_start: '2026-09-01', period_end: '2026-09-30' }]
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15')], draftRosters }).status).toBe('pending')
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15', pub), b('2026-09-16')], draftRosters }).status).toBe('pending')
    expect(PUBLICATION_LABELS.pending).toBe('Draft (awaiting approval)')
  })

  it('a draft that does not overlap the period is ignored', () => {
    const draftRosters = [{ status: 'draft', period_start: '2026-09-21', period_end: '2026-09-27' }]
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15')], draftRosters }).status).toBe('unpublished')
  })

  it('a fully published period with a draft over it stays published, flagged draftPending', () => {
    const draftRosters = [{ status: 'draft', period_start: '2026-09-20', period_end: '2026-09-20' }]
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15', pub)], draftRosters }))
      .toMatchObject({ status: 'published', draftPending: true })
  })

  it('a block carrying a draft roster counts as pending too', () => {
    expect(periodPublicationStatus({ ...period, blocks: [b('2026-09-15', { status: 'draft' })] }).status).toBe('pending')
  })

  it('none when the period has no blocks and no draft', () => {
    expect(periodPublicationStatus({ ...period, blocks: [] }).status).toBe('none')
    expect(periodPublicationStatus({ ...period, blocks: null }).status).toBe('none')
  })
})

// SHIFTTYPE.1 — an admin shift carries no minimum staffing (Richard, 25 Sep):
// it is never empty and never short, on any surface.
describe('SHIFTTYPE.1 — admin shifts are never a staffing gap', () => {
  const admin = (over = {}) => block({ min_coaches: 0, shift_templates: { name: 'Admin', kind: 'admin' }, ...over })

  it('futureBlockStaffing asks no staffing question of a future admin block, empty or not', () => {
    expect(futureBlockStaffing(admin(), '2026-09-17')).toBeNull()
    expect(futureBlockStaffing(admin({ shift_assignments: [live('a')] }), '2026-09-17')).toBeNull()
    // Even one still carrying a minimum (a block made before its template became admin).
    expect(futureBlockStaffing(admin({ min_coaches: 2, shift_assignments: [live('a')] }), '2026-09-17')).toBeNull()
  })

  it('class blocks are unchanged, and a block with no readable kind is class', () => {
    expect(futureBlockStaffing(block({ shift_templates: { kind: 'class' } }), '2026-09-17').status).toBe('empty')
    expect(futureBlockStaffing(block({ shift_templates: { kind: 'class' }, shift_assignments: [live('a')] }), '2026-09-17'))
      .toEqual({ status: 'short', count: 1, min: 2 })
    expect(futureBlockStaffing(block(), '2026-09-17').status).toBe('empty')
  })

  it('staffingGaps and countStaffingGaps leave admin blocks out', () => {
    const blocks = [
      admin({ id: 'admin-empty', block_date: '2026-09-18' }),
      block({ id: 'class-empty', block_date: '2026-09-18' }),
      block({ id: 'class-short', block_date: '2026-09-19', shift_assignments: [live('a')] }),
    ]
    expect(staffingGaps(blocks, { todayIso: '2026-09-17' }).map((g) => g.block.id)).toEqual(['class-empty', 'class-short'])
    expect(countStaffingGaps(blocks, { todayIso: '2026-09-17' })).toEqual({ empty: 1, short: 1, total: 2 })
    expect(countStaffingGaps([admin(), admin({ id: 'a2' })], { todayIso: '2026-09-17' })).toEqual({ empty: 0, short: 0, total: 0 })
  })

  it('the Today chip reads each block with its template kind and does not count an admin block', async () => {
    const calls = {}
    const chain = {
      select: (s) => { calls.select = s; return chain },
      in: () => chain,
      gte: () => chain,
      lte: () => Promise.resolve({ data: [admin({ block_date: '2026-09-18' }), block({ block_date: '2026-09-19' })], error: null }),
    }
    const res = await fetchStaffingGapsThisWeek({ from: () => chain }, ['loc-1'], { todayIso: '2026-09-17' })
    expect(res).toEqual({ success: true, data: { empty: 1, short: 0, total: 1 } })
    expect(calls.select).toMatch(/shift_templates\(kind\)/)
  })
})
