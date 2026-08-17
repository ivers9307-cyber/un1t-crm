import { describe, it, expect } from 'vitest'
import { monthWrappedModel, monthWrappedKey } from './month-wrapped.js'
import { monthlyRecap, personalRecords } from './progress-analytics.js'

const DAY = 24 * 3600 * 1000
// "Now" = 3 July 2026, 12:00 Dublin (IST, UTC+1). Last completed month = June 2026.
const now = Date.parse('2026-07-03T11:00:00Z')

// Build a session anchored to a specific UTC calendar day (safe: mid-day so
// Dublin/UTC agree on the month).
const sOn = (iso, over = {}) => ({
  id: `s-${iso}`,
  started_at: `${iso}T12:00:00Z`,
  ended_at: `${iso}T12:45:00Z`,
  effort_points: 100, peak_hr_bpm: 170, avg_hr_bpm: 150, zones_seconds: {}, source: 'ble_bridge',
  ...over,
})

describe('monthWrappedModel — the last-completed month', () => {
  it('resolves June 2026 as the recapped month with all fields', () => {
    const sessions = [
      sOn('2026-06-05', { effort_points: 120, peak_hr_bpm: 165 }),
      sOn('2026-06-18', { effort_points: 80, peak_hr_bpm: 175 }),
      sOn('2026-07-01', { effort_points: 200 }), // current month — excluded
    ]
    const recap = monthlyRecap(sessions, now, 6)
    const records = personalRecords(sessions)
    const m = monthWrappedModel(recap, records, now)

    expect(m.hasContent).toBe(true)
    expect(m.monthKey).toBe('2026-06')
    expect(m.label).toBe('June 2026')
    expect(m.monthName).toBe('June')
    expect(m.year).toBe(2026)
    expect(m.sessions).toBe(2)
    expect(m.points).toBe(200)     // 120 + 80, current-month session excluded
    expect(m.minutes).toBe(90)     // 45 + 45
    expect(m.avgPeakHr).toBe(170)  // (165 + 175) / 2
  })

  it('returns hasContent:false when last month had no sessions', () => {
    // Only current-month sessions → June is empty.
    const sessions = [sOn('2026-07-02')]
    const recap = monthlyRecap(sessions, now, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), now)
    expect(m.hasContent).toBe(false)
    expect(m.monthKey).toBe('2026-06') // still labels the month it would recap
    expect(m.label).toBe('June 2026')
    expect(m.points).toBe(0)
    expect(m.sessions).toBe(0)
    expect(m.pr).toBeNull()
  })

  it('returns hasContent:false on empty / missing input without throwing', () => {
    expect(monthWrappedModel(null, null, now).hasContent).toBe(false)
    expect(monthWrappedModel({}, {}, now).hasContent).toBe(false)
    expect(monthWrappedModel({ months: [] }, undefined, now).hasContent).toBe(false)
  })
})

describe('monthWrappedModel — fittest detection', () => {
  it('flags isFittest when the recapped month is the all-time best', () => {
    // June is the biggest month; earlier months are smaller.
    const sessions = [
      sOn('2026-04-10', { effort_points: 50 }),
      sOn('2026-05-10', { effort_points: 60 }),
      sOn('2026-06-10', { effort_points: 300 }),
      sOn('2026-06-20', { effort_points: 300 }),
    ]
    const recap = monthlyRecap(sessions, now, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), now)
    expect(m.isFittest).toBe(true)
  })

  it('does NOT flag isFittest when an earlier month was bigger', () => {
    const sessions = [
      sOn('2026-05-10', { effort_points: 500 }), // May is the fittest
      sOn('2026-06-10', { effort_points: 100 }),
    ]
    const recap = monthlyRecap(sessions, now, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), now)
    expect(m.isFittest).toBe(false)
    expect(m.hasContent).toBe(true) // June still has content
  })
})

describe('monthWrappedModel — PR highlight (best-effort)', () => {
  it('surfaces a best-session PR set during the recapped month', () => {
    const sessions = [
      sOn('2026-05-10', { id: 'may', effort_points: 100 }),
      sOn('2026-06-15', { id: 'jun', effort_points: 400, peak_hr_bpm: 150 }), // best session, in June
    ]
    const recap = monthlyRecap(sessions, now, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), now)
    expect(m.pr).toEqual({ kind: 'points', label: 'New best session', value: 400, unit: 'pts' })
  })

  it('surfaces a highest-peak PR when best-session PR is from another month', () => {
    const sessions = [
      sOn('2026-05-10', { id: 'may', effort_points: 999, peak_hr_bpm: 150 }), // best session is May
      sOn('2026-06-15', { id: 'jun', effort_points: 100, peak_hr_bpm: 195 }), // highest peak is June
    ]
    const recap = monthlyRecap(sessions, now, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), now)
    expect(m.pr).toEqual({ kind: 'peak', label: 'Highest peak HR ever', value: 195, unit: 'bpm' })
  })

  it('returns pr:null when the all-time records were set in an earlier month', () => {
    const sessions = [
      sOn('2026-05-10', { id: 'may', effort_points: 999, peak_hr_bpm: 199 }),
      sOn('2026-06-15', { id: 'jun', effort_points: 100, peak_hr_bpm: 150 }),
    ]
    const recap = monthlyRecap(sessions, now, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), now)
    expect(m.pr).toBeNull()
  })
})

describe('monthWrappedKey — data-free completed-month key', () => {
  it('derives the last completed Dublin month from the clock alone', () => {
    // 3 July 2026, 12:00 Dublin (IST) → completed month = June 2026.
    expect(monthWrappedKey(now)).toBe('2026-06')
  })

  it('rolls over the year in January (December of the prior year)', () => {
    // 2 Jan 2026, 12:00 Dublin (GMT) → completed month = December 2025.
    expect(monthWrappedKey(Date.parse('2026-01-02T12:00:00Z'))).toBe('2025-12')
  })

  it('uses the Dublin calendar month (IST just-after-midnight on the 1st)', () => {
    // 1 July 2026, 00:30 Dublin (IST) = 2026-06-30T23:30Z. Dublin month is
    // July → completed month is June, NOT May (the naive UTC read).
    expect(monthWrappedKey(Date.parse('2026-06-30T23:30:00Z'))).toBe('2026-06')
  })

  it('zero-pads single-digit months', () => {
    // 15 Feb 2026 → completed month = January 2026 ('01', padded).
    expect(monthWrappedKey(Date.parse('2026-02-15T12:00:00Z'))).toBe('2026-01')
  })

  it('always matches monthWrappedModel(...).monthKey for the same instant', () => {
    for (const iso of ['2026-07-03T11:00:00Z', '2026-01-02T12:00:00Z', '2026-06-30T23:30:00Z']) {
      const ms = Date.parse(iso)
      expect(monthWrappedModel(null, null, ms).monthKey).toBe(monthWrappedKey(ms))
    }
  })
})

describe('monthWrappedModel — month/year boundary', () => {
  it('recaps December of the prior year when now is early January', () => {
    // 2 Jan 2026, 12:00 Dublin (GMT) → last completed month = December 2025.
    const janNow = Date.parse('2026-01-02T12:00:00Z')
    const sessions = [sOn('2025-12-20', { effort_points: 150 })]
    const recap = monthlyRecap(sessions, janNow, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), janNow)
    expect(m.monthKey).toBe('2025-12')
    expect(m.label).toBe('December 2025')
    expect(m.year).toBe(2025)
    expect(m.hasContent).toBe(true)
    expect(m.points).toBe(150)
  })

  it('uses the Dublin month for "now" (IST just-after-midnight on the 1st)', () => {
    // 1 July 2026, 00:30 Dublin (IST) = 2026-06-30T23:30Z. Dublin month is
    // July, so the completed month is June — NOT May (which a naive UTC read
    // of the instant, still 30 June, would give via prevMonth).
    const istEdgeNow = Date.parse('2026-06-30T23:30:00Z')
    const sessions = [
      sOn('2026-05-10', { effort_points: 80 }),
      sOn('2026-06-10', { effort_points: 120 }),
    ]
    const recap = monthlyRecap(sessions, istEdgeNow, 6)
    const m = monthWrappedModel(recap, personalRecords(sessions), istEdgeNow)
    expect(m.monthKey).toBe('2026-06')
    expect(m.label).toBe('June 2026')
  })
})
