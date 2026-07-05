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

describe('renderCoverageReportHtml — v2 sections', () => {
  const baseSection = {
    locationName: 'Stillorgan',
    stats: { pulled: 0, new: 0, covered: 0 },
    anomalies: [],
    uncovered: [],
  }

  it('renders found/inReview/needsAttention sections with correct headings and escaped content', () => {
    const html = renderCoverageReportHtml({
      appUrl: 'https://x.test',
      dateStr: '2026-07-04',
      sections: [{
        ...baseSection,
        found: [
          { line_date: '2026-07-01', description: 'MUSCLEFOOD LTD', amount: -84.5, supplier_name: '<b>Musclefood</b>', deduped: false },
        ],
        inReview: [
          { line_date: '2026-07-02', description: 'ESB ELECTRIC', amount: -120, queue_status: 'quality_approved' },
        ],
        needsAttention: [
          { line_date: '2026-06-30', description: 'OFFICE SUPPLIES', amount: -45, reject_reason: '<b>blurry</b>' },
        ],
        uncovered: [
          { line_date: '2026-06-20', description: 'STILL MISSING LTD', reference: 'CARD 999', amount: -10 },
        ],
      }],
      errors: [],
    })

    expect(html).toContain('Found &amp; submitted this week')
    expect(html).toContain('color:#2e7d32')
    expect(html).toContain('MUSCLEFOOD LTD')
    expect(html).toContain('&lt;b&gt;Musclefood&lt;/b&gt;')
    expect(html).not.toContain('<b>Musclefood</b>')

    expect(html).toContain('In review — working through the invoice queue')
    expect(html).toContain('ESB ELECTRIC')
    expect(html).toContain('quality_approved')

    expect(html).toContain('Needs your attention — submitted document was rejected')
    expect(html).toContain('color:#c62828')
    expect(html).toContain('OFFICE SUPPLIES')
    expect(html).toContain('&lt;b&gt;blurry&lt;/b&gt;')
    expect(html).not.toContain('<b>blurry</b>')

    expect(html).toContain('Still no invoice found — chase list')
  })

  it('appends "(already in queue)" to the supplier cell for a deduped find', () => {
    const html = renderCoverageReportHtml({
      appUrl: 'https://x.test',
      dateStr: '2026-07-04',
      sections: [{
        ...baseSection,
        found: [
          { line_date: '2026-07-01', description: 'MUSCLEFOOD LTD', amount: -84.5, supplier_name: 'Musclefood', deduped: true },
        ],
      }],
      errors: [],
    })

    expect(html).toContain('Musclefood (already in queue)')
  })

  it('renders none of the three new headings when their arrays are empty or omitted', () => {
    const html = renderCoverageReportHtml({
      appUrl: 'https://x.test',
      dateStr: '2026-07-04',
      sections: [{
        ...baseSection,
        found: [],
        inReview: [],
        needsAttention: [],
      }],
      errors: [],
    })

    expect(html).not.toContain('Found &amp; submitted this week')
    expect(html).not.toContain('In review — working through the invoice queue')
    expect(html).not.toContain('Needs your attention — submitted document was rejected')

    // Same when the keys are omitted entirely (default via destructuring).
    const htmlOmitted = renderCoverageReportHtml({
      appUrl: 'https://x.test',
      dateStr: '2026-07-04',
      sections: [{ ...baseSection }],
      errors: [],
    })
    expect(htmlOmitted).not.toContain('Found &amp; submitted this week')
    expect(htmlOmitted).not.toContain('In review — working through the invoice queue')
    expect(htmlOmitted).not.toContain('Needs your attention — submitted document was rejected')
  })
})
