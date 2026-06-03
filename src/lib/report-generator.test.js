// RETIRE-SHIFTS-MIRROR.1 — tests for the new-model shift fetcher that the
// report generators use in place of the legacy public.shifts mirror.
import { describe, it, expect } from 'vitest'
import {
  fetchScheduledShiftRows,
  humanizeReportKey,
  formatReportValue,
  buildReportEmailHtml,
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
