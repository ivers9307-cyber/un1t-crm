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
} from './roster'

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

  beforeEach(() => {
    upsertMock = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({
        // Pretend everything inserted (3 weeks × Mon/Wed/Fri = ~24).
        data: Array(24).fill(0).map((_, i) => ({ id: `block-${i}` })),
        error: null,
      }),
    })
    fromMock = vi.fn().mockReturnValue({ upsert: upsertMock })
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
    const errDb = { from: vi.fn().mockReturnValue({ upsert: errUpsert }) }

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
