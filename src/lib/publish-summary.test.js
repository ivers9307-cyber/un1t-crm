// PUBLISH-CONFIRM.1 — the sentence the publish modal shows once it lands.

import { describe, it, expect } from 'vitest'
import { publishedSummaryLine } from './publish-summary'

describe('publishedSummaryLine', () => {
  it('counts shifts and coaches, and says which period', () => {
    expect(publishedSummaryLine({ shift_count: 34, coaches_notified: 6 }, 'September 2026'))
      .toBe('34 shifts for September 2026 are live. 6 coaches were told.')
  })

  it('reads singular for one shift and one coach', () => {
    expect(publishedSummaryLine({ shift_count: 1, coaches_notified: 1 }, '2026-05-04'))
      .toBe('1 shift for 2026-05-04 is live. 1 coach was told.')
  })

  // A re-publish where nothing moved messages nobody. "0 coaches were told"
  // reads as a failed send; it is the correct outcome.
  it('explains a zero rather than printing it', () => {
    expect(publishedSummaryLine({ shift_count: 12, coaches_notified: 0 }, 'September 2026'))
      .toBe('12 shifts for September 2026 are live. Nothing changed for any coach, so nobody was messaged.')
  })

  it('never invents a count when the server sent no summary', () => {
    expect(publishedSummaryLine(null, 'September 2026')).toBe('The roster for September 2026 is live.')
    expect(publishedSummaryLine({}, 'September 2026')).toBe('The roster for September 2026 is live.')
    expect(publishedSummaryLine(undefined, '')).toBe('The roster is live.')
  })
})
