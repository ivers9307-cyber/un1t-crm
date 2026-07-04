import { describe, it, expect } from 'vitest'
import { renderCoverageReportHtml, shouldRunFridayCron } from './report-email'

describe('renderCoverageReportHtml', () => {
  it('lists uncovered lines per location and links the board', () => {
    const html = renderCoverageReportHtml({
      appUrl: 'https://crm.un1tdublin.com',
      dateStr: '2026-07-04',
      sections: [{
        locationName: 'Stillorgan',
        stats: { pulled: 6, new: 2, covered: 1 },
        anomalies: [],
        uncovered: [
          { line_date: '2026-06-03', description: 'MUSCLEFOOD LTD', reference: 'CARD 1234', amount: -84.5 },
        ],
      }],
      errors: [],
    })
    expect(html).toContain('Stillorgan')
    expect(html).toContain('MUSCLEFOOD LTD')
    expect(html).toContain('-€84.50')
    expect(html).toContain('https://crm.un1tdublin.com/accounting')
  })

  it('escapes HTML in line fields', () => {
    const html = renderCoverageReportHtml({
      appUrl: 'https://x.test', dateStr: '2026-07-04',
      sections: [{
        locationName: 'S', stats: { pulled: 1, new: 1, covered: 0 }, anomalies: [],
        uncovered: [{ line_date: '2026-07-01', description: '<img src=x onerror=1>', reference: 'A&B', amount: -1 }],
      }],
      errors: [],
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
    expect(html).toContain('A&amp;B')
  })

  it('surfaces per-location pull errors and account anomalies instead of hiding them', () => {
    const html = renderCoverageReportHtml({
      appUrl: 'https://x.test', dateStr: '2026-07-04',
      sections: [{
        locationName: 'Stillorgan', stats: { pulled: 0, new: 0, covered: 0 },
        anomalies: [{ bankAccountName: 'Current', skipped: 'zero_rows_anomaly' }],
        uncovered: [],
      }],
      errors: [{ locationName: 'Hatch', error: 'reconnect required' }],
    })
    expect(html).toContain('Hatch')
    expect(html).toContain('reconnect required')
    expect(html).toContain('Current')
    expect(html).toMatch(/anomal/i)
  })
})

describe('shouldRunFridayCron', () => {
  it('runs only in the 08:xx Dublin hour and only once per day', () => {
    expect(shouldRunFridayCron({ dublinMinutes: 8 * 60 + 5, alreadyRanToday: false })).toBe(true)
    expect(shouldRunFridayCron({ dublinMinutes: 7 * 60 + 5, alreadyRanToday: false })).toBe(false)
    expect(shouldRunFridayCron({ dublinMinutes: 9 * 60, alreadyRanToday: false })).toBe(false)
    expect(shouldRunFridayCron({ dublinMinutes: 8 * 60 + 5, alreadyRanToday: true })).toBe(false)
  })
})
