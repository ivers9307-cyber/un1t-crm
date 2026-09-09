// RETIRE-SHIFTS-MIRROR.1 — tests for the new-model shift fetcher that the
// report generators use in place of the legacy public.shifts mirror.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import {
  fetchScheduledShiftRows,
  humanizeReportKey,
  formatReportValue,
  buildReportEmailHtml,
  calculateNextRun,
  calculatePeriodForSchedule,
  generateReport,
} from './report-generator'

// Minimal thenable mock of the supabase query builder: every filter method
// returns the builder; awaiting it resolves to { data }.
function mockDb(rows) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    lte: () => builder,
    then: (onFulfilled, onRejected) => Promise.resolve({ data: rows }).then(onFulfilled, onRejected),
  }
  return { from: () => builder }
}

describe('fetchScheduledShiftRows', () => {
  it('normalises new-model rows to the legacy shift shape', async () => {
    const rows = [{
      profile_id: 'p1',
      start_time_override: '09:00:00',
      end_time_override: null,
      status: 'scheduled',
      profiles: { full_name: 'Jane', role: 'staff', employment_type: 'fte' },
      shift_blocks: {
        block_date: '2026-06-06',
        location_id: 'loc1',
        shift_templates: { name: 'AM', start_time: '09:30:00', end_time: '10:30:00' },
      },
    }]
    const out = await fetchScheduledShiftRows(mockDb(rows), {
      locationId: 'loc1', periodStart: '2026-06-01', periodEnd: '2026-06-30',
    })
    expect(out).toEqual([{
      shift_date: '2026-06-06',
      profile_id: 'p1',
      start_time_override: '09:00:00',
      end_time_override: null,
      status: 'scheduled',
      profiles: { full_name: 'Jane', role: 'staff', employment_type: 'fte' },
      shift_templates: { name: 'AM', start_time: '09:30:00', end_time: '10:30:00' },
    }])
  })

  it('maps block_date → shift_date and surfaces template through the block', async () => {
    const rows = [{
      profile_id: 'p2', start_time_override: null, end_time_override: null, status: 'confirmed',
      profiles: { full_name: 'Sam' },
      shift_blocks: { block_date: '2026-06-07', location_id: 'loc1', shift_templates: { name: 'PM', start_time: '17:00:00', end_time: '18:00:00' } },
    }]
    const [row] = await fetchScheduledShiftRows(mockDb(rows), { locationId: 'loc1', periodStart: '2026-06-01', periodEnd: '2026-06-30' })
    expect(row.shift_date).toBe('2026-06-07')
    expect(row.shift_templates.start_time).toBe('17:00:00')
  })

  it('returns [] for empty / null data', async () => {
    expect(await fetchScheduledShiftRows(mockDb([]), { locationId: 'x', periodStart: 'a', periodEnd: 'b' })).toEqual([])
    expect(await fetchScheduledShiftRows(mockDb(null), { locationId: 'x', periodStart: 'a', periodEnd: 'b' })).toEqual([])
  })

  // ROSTER-FIX.1 — a cancelled assignment is a dropped shift: paying it in
  // staff_hours / staff_cost and counting it as coverage was a real defect.
  it('drops cancelled assignments', async () => {
    const rows = [
      {
        profile_id: 'live', start_time_override: null, end_time_override: null, status: 'scheduled',
        profiles: { full_name: 'Live' },
        shift_blocks: { block_date: '2026-06-06', location_id: 'loc1', shift_templates: { name: 'AM' } },
      },
      {
        profile_id: 'dead', start_time_override: null, end_time_override: null, status: 'cancelled',
        profiles: { full_name: 'Dead' },
        shift_blocks: { block_date: '2026-06-06', location_id: 'loc1', shift_templates: { name: 'AM' } },
      },
    ]
    const out = await fetchScheduledShiftRows(mockDb(rows), { locationId: 'loc1', periodStart: '2026-06-01', periodEnd: '2026-06-30' })
    expect(out.map((r) => r.profile_id)).toEqual(['live'])
  })

  it('tolerates a row missing its block embed (no throw)', async () => {
    const out = await fetchScheduledShiftRows(mockDb([{ profile_id: 'p3', profiles: { full_name: 'Lee' } }]), { locationId: 'x', periodStart: 'a', periodEnd: 'b' })
    expect(out[0]).toMatchObject({ profile_id: 'p3', shift_date: undefined, shift_templates: undefined })
  })
})

// ─── Scheduled-report email delivery ─────────────────────────────────────────

describe('humanizeReportKey', () => {
  it('title-cases snake_case keys', () => {
    expect(humanizeReportKey('total_hours')).toBe('Total Hours')
    expect(humanizeReportKey('avg_shifts_per_day')).toBe('Avg Shifts Per Day')
    expect(humanizeReportKey('staff_count')).toBe('Staff Count')
  })
})

describe('formatReportValue', () => {
  it('formats money keys with the currency symbol + 2dp + thousands separators', () => {
    expect(formatReportValue('total_cost', 1453.5, 'EUR')).toBe('€1,453.50')
    expect(formatReportValue('total_regular_cost', 12000, 'EUR')).toBe('€12,000.00')
    expect(formatReportValue('total_cost', 1453.5, 'GBP')).toBe('£1,453.50')
  })

  it('falls back to no symbol when currency is unknown/absent', () => {
    expect(formatReportValue('total_cost', 99.9, undefined)).toBe('99.90')
  })

  it('formats plain counts/hours with thousands separators and ≤1dp', () => {
    expect(formatReportValue('staff_count', 12)).toBe('12')
    expect(formatReportValue('total_hours', 1234.56)).toBe('1,234.6')
    expect(formatReportValue('total_days', 1000)).toBe('1,000')
  })

  it('passes through strings and renders nullish as a dash', () => {
    expect(formatReportValue('currency', 'EUR')).toBe('EUR')
    expect(formatReportValue('total_cost', null, 'EUR')).toBe('—')
    expect(formatReportValue('x', undefined)).toBe('—')
  })
})

describe('buildReportEmailHtml', () => {
  const report = {
    report_name: 'Staff Cost',
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    summary: { total_hours: 320.5, total_cost: 6400, staff_count: 8, currency: 'EUR' },
  }

  it('renders the report name, period range and each summary row', () => {
    const html = buildReportEmailHtml(report, { appUrl: 'https://crm.un1tdublin.com' })
    expect(html).toContain('Staff Cost')
    expect(html).toContain('2026-05-01 → 2026-05-31')
    expect(html).toContain('Total Hours')
    expect(html).toContain('Total Cost')
    expect(html).toContain('€6,400.00')
    expect(html).toContain('Staff Count')
  })

  it('omits the raw currency key from the rendered rows', () => {
    const html = buildReportEmailHtml(report, {})
    // 'currency' as a metadata key shouldn't appear as a humanized row label
    expect(html).not.toContain('>Currency<')
  })

  it('includes a Reporting CTA only when an appUrl is provided', () => {
    expect(buildReportEmailHtml(report, { appUrl: 'https://x.test' }))
      .toContain('https://x.test/schedule')
    expect(buildReportEmailHtml(report, {})).not.toContain('Schedule → Reporting')
  })

  it('collapses an identical start/end into a single date', () => {
    const html = buildReportEmailHtml({ ...report, period_end: '2026-05-01' }, {})
    expect(html).toContain('2026-05-01')
    expect(html).not.toContain('→')
  })

  it('shows an empty-state row when there is no summary data', () => {
    const html = buildReportEmailHtml({ report_name: 'Empty', period_start: '2026-05-01', period_end: '2026-05-01', summary: {} }, {})
    expect(html).toContain('No data for this period.')
  })
})

// ─── ROSTER-FIX.5 — scheduling arithmetic ────────────────────────────────────
//
// Both helpers are called once per due schedule by
// /api/cron/run-scheduled-reports. `daily` was reachable in the POST schema
// but understood by neither: calculateNextRun returned null (so a daily
// schedule ran once and never again) and calculatePeriodForSchedule fell
// through to the 7-day default (so a "daily" report covered a week).

// Local-clock expectation: these helpers do their arithmetic with local Date
// components, so build the expectation the same way rather than hard-coding a
// UTC string that only passes in one timezone.
function expectedRun(daysAhead, from) {
  const d = new Date(from)
  d.setDate(d.getDate() + daysAhead)
  d.setHours(7, 0, 0, 0)
  return d.toISOString()
}

describe('calculateNextRun', () => {
  // 2026-05-06 is a Wednesday (JS getDay() === 3).
  const NOW = new Date('2026-05-06T09:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => { vi.useRealTimers() })

  it('daily → tomorrow at 07:00 local', () => {
    expect(calculateNextRun('daily')).toBe(expectedRun(1, NOW))
  })

  it('daily ignores day_of_week / day_of_month', () => {
    expect(calculateNextRun('daily', 5, 12)).toBe(expectedRun(1, NOW))
  })

  it('weekly → the next occurrence of that weekday', () => {
    // Friday (5) is 2 days after Wednesday.
    expect(calculateNextRun('weekly', 5)).toBe(expectedRun(2, NOW))
  })

  it('weekly on TODAY\'s weekday → a full week out, never today', () => {
    expect(calculateNextRun('weekly', 3)).toBe(expectedRun(7, NOW))
  })

  it('fortnightly → the next occurrence plus a week', () => {
    expect(calculateNextRun('fortnightly', 5)).toBe(expectedRun(2 + 7, NOW))
  })

  it('fortnightly on TODAY\'s weekday → 14 days, not 7', () => {
    expect(calculateNextRun('fortnightly', 3)).toBe(expectedRun(7 + 7, NOW))
  })

  it('monthly → the given day of next month at 07:00', () => {
    const out = new Date(calculateNextRun('monthly', null, 12))
    expect(out.getMonth()).toBe(5) // June
    expect(out.getDate()).toBe(12)
    expect(out.getHours()).toBe(7)
  })

  it('once → null (nothing to advance to)', () => {
    expect(calculateNextRun('once')).toBeNull()
  })

  it('weekly/fortnightly without a weekday → null rather than a wrong date', () => {
    expect(calculateNextRun('weekly', null)).toBeNull()
    expect(calculateNextRun('fortnightly', null)).toBeNull()
  })
})

describe('calculatePeriodForSchedule', () => {
  // Run the clock at the cron's own hour so the UTC date arithmetic in the
  // helper matches what an operator would call "yesterday".
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-06T07:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('daily → yesterday only, not a week', () => {
    expect(calculatePeriodForSchedule('daily')).toEqual({
      period_start: '2026-05-05', period_end: '2026-05-05',
    })
  })

  it('weekly → the 7 days ending yesterday', () => {
    expect(calculatePeriodForSchedule('weekly')).toEqual({
      period_start: '2026-04-29', period_end: '2026-05-05',
    })
  })

  it('fortnightly → the 14 days ending yesterday', () => {
    expect(calculatePeriodForSchedule('fortnightly')).toEqual({
      period_start: '2026-04-22', period_end: '2026-05-05',
    })
  })

  it('monthly → the previous full calendar month', () => {
    expect(calculatePeriodForSchedule('monthly')).toEqual({
      period_start: '2026-04-01', period_end: '2026-04-30',
    })
  })

  it('an unknown frequency falls back to the last 7 days', () => {
    expect(calculatePeriodForSchedule('quarterly')).toEqual({
      period_start: '2026-04-29', period_end: '2026-05-05',
    })
  })
})

// ─── ROSTER-FIX.5 — generateReport: adjusted hours + location scope ──────────
//
// Two defects, both of which quietly overstate a report:
//   • staff_hours and utilisation re-derived duration from the TEMPLATE's
//     start/end and ignored start_time_override / end_time_override, so a
//     shift a manager had shortened or extended was reported at its
//     template length. staff_cost already went through shiftHours() and so
//     disagreed with staff_hours for the same shifts.
//   • utilisation and staff_cost listed EVERY active profile in the estate,
//     not the ones who work at the report's location — so a location's
//     utilisation average was diluted by staff who could never appear on its
//     roster, and its cost report enumerated the whole company's payroll.

function makeReportDb(tables) {
  const captured = {}
  const from = vi.fn((table) => {
    const b = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      lte: () => b,
      order: () => b,
      in: (col, vals) => { captured[`${table}.in`] = { col, vals }; return b },
      insert: (rec) => { captured.inserted = rec; return b },
      single: () => Promise.resolve({ data: { id: 'gen-1', ...captured.inserted }, error: null }),
      then: (ok, err) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok, err),
    }
    return b
  })
  return { db: { from }, captured }
}

// Two coaches: one at the report's location, one who is not.
const PL_ROWS = [{ profile_id: 'p-here' }]
const PROFILES = [
  { id: 'p-here', full_name: 'Coach Here', role: 'staff', employment_type: 'fte', contracted_hours_per_week: 10, annual_salary: 26000, hourly_rate: null, overtime_rate: null },
  { id: 'p-away', full_name: 'Coach Away', role: 'staff', employment_type: 'fte', contracted_hours_per_week: 10, annual_salary: 26000, hourly_rate: null, overtime_rate: null },
]

// A 09:00-12:00 template that a manager cut to 09:00-10:00 on the day.
function assignmentRow(profileId, { startOverride = null, endOverride = null, date = '2026-05-04' } = {}) {
  return {
    profile_id: profileId,
    start_time_override: startOverride,
    end_time_override: endOverride,
    status: 'scheduled',
    profiles: { full_name: profileId, role: 'staff', employment_type: 'fte' },
    shift_blocks: {
      block_date: date,
      location_id: 'loc1',
      shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '12:00:00' },
    },
  }
}

const PERIOD = { period_start: '2026-05-04', period_end: '2026-05-10', location_id: 'loc1' }

describe('generateReport — staff_hours honours adjusted hours', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('reports the override window, not the template window', async () => {
    const { db, captured } = makeReportDb({
      shift_assignments: [assignmentRow('p-here', { startOverride: '09:00:00', endOverride: '10:00:00' })],
    })
    createServerClient.mockReturnValue(db)

    const res = await generateReport({ report_type: 'staff_hours', ...PERIOD })
    expect(res.success).toBe(true)
    expect(captured.inserted.summary.total_hours).toBe(1)
    expect(captured.inserted.report_data.staff[0].total).toBe(1)
  })

  it('falls back to the template when there is no override', async () => {
    const { db, captured } = makeReportDb({ shift_assignments: [assignmentRow('p-here')] })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'staff_hours', ...PERIOD })
    expect(captured.inserted.summary.total_hours).toBe(3)
  })

  it('a half-open override still resolves — end override, template start', async () => {
    const { db, captured } = makeReportDb({
      shift_assignments: [assignmentRow('p-here', { endOverride: '13:30:00' })],
    })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'staff_hours', ...PERIOD })
    expect(captured.inserted.summary.total_hours).toBe(4.5)
  })
})

describe('generateReport — utilisation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('counts the override hours', async () => {
    const { db, captured } = makeReportDb({
      profile_locations: PL_ROWS,
      profiles: [PROFILES[0]],
      shift_assignments: [assignmentRow('p-here', { startOverride: '09:00:00', endOverride: '10:00:00' })],
    })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'utilisation', ...PERIOD })
    expect(captured.inserted.report_data.staff[0].actual_hours).toBe(1)
  })

  it('restricts profiles to the location via profile_locations', async () => {
    const { db, captured } = makeReportDb({
      profile_locations: PL_ROWS,
      profiles: [PROFILES[0]],
      shift_assignments: [assignmentRow('p-here')],
    })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'utilisation', ...PERIOD })
    expect(db.from).toHaveBeenCalledWith('profile_locations')
    expect(captured['profiles.in']).toEqual({ col: 'id', vals: ['p-here'] })
    // Only the location's staff are in the denominator of the average.
    expect(captured.inserted.report_data.staff.map(s => s.name)).toEqual(['Coach Here'])
  })

  it('no staff at the location → an empty report, not the whole estate', async () => {
    const { db, captured } = makeReportDb({
      profile_locations: [],
      profiles: [],
      shift_assignments: [],
    })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'utilisation', ...PERIOD })
    expect(captured['profiles.in']).toEqual({ col: 'id', vals: [] })
    expect(captured.inserted.summary.staff_count).toBe(0)
  })
})

describe('generateReport — staff_cost', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('restricts profiles to the location via profile_locations', async () => {
    const { db, captured } = makeReportDb({
      profile_locations: PL_ROWS,
      profiles: [PROFILES[0]],
      shift_assignments: [assignmentRow('p-here'), assignmentRow('p-away')],
    })
    createServerClient.mockReturnValue(db)

    await generateReport({ report_type: 'staff_cost', ...PERIOD })
    expect(captured['profiles.in']).toEqual({ col: 'id', vals: ['p-here'] })
    // A shift belonging to a profile outside the location is not costed —
    // the generator already skips shifts with no matching profile.
    expect(captured.inserted.report_data.staff.map(s => s.name)).toEqual(['Coach Here'])
  })
})

describe('generateReport — the staff-list query failing is not "no staff"', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('surfaces the error instead of saving an empty report', async () => {
    const from = vi.fn((table) => {
      const b = {
        select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b,
        insert: () => b, single: () => Promise.resolve({ data: { id: 'x' }, error: null }),
        then: (ok, err) => Promise.resolve(
          table === 'profile_locations' ? { data: null, error: { message: 'boom' } } : { data: [] }
        ).then(ok, err),
      }
      return b
    })
    createServerClient.mockReturnValue({ from })

    const res = await generateReport({ report_type: 'utilisation', ...PERIOD })
    expect(res).toMatchObject({ success: false })
    expect(res.error).toMatch(/boom/)
    expect(from).not.toHaveBeenCalledWith('generated_reports')
  })
})
