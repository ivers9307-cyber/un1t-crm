import { describe, it, expect } from 'vitest'
import { dominantZone, tracePolyline, shortName, cardModel } from './share-card.js'

const zones = (secs) => [
  { id: 1, name: 'Warm-up', color: '#9CA3AF', seconds: secs[0], percent: 0 },
  { id: 2, name: 'Easy', color: '#3B82F6', seconds: secs[1], percent: 0 },
  { id: 3, name: 'Aerobic', color: '#10B981', seconds: secs[2], percent: 0 },
  { id: 4, name: 'Threshold', color: '#F59E0B', seconds: secs[3], percent: 0 },
  { id: 5, name: 'Max', color: '#EF4444', seconds: secs[4], percent: 0 },
]

describe('dominantZone', () => {
  it('picks the highest-intensity zone with a real share of time', () => {
    expect(dominantZone(zones([60, 110, 290, 340, 200])).id).toBe(5)
  })
  it('ignores a trivially-small top zone (<10% and <30s)', () => {
    expect(dominantZone(zones([60, 200, 390, 340, 10])).id).toBe(4)
  })
  it('falls back to a brand accent (not flat grey) for a warm-up-only session', () => {
    expect(dominantZone(zones([600, 0, 0, 0, 0])).color).toBe('#0B0B0C')
  })
  it('handles all-zero (no data) with the brand accent', () => {
    expect(dominantZone(zones([0, 0, 0, 0, 0])).color).toBe('#0B0B0C')
  })
})

describe('tracePolyline', () => {
  it('maps samples to points filling the box, normalised to their own range', () => {
    const s = [{ bpm: 100 }, { bpm: 150 }, { bpm: 125 }].map((x, i) => ({ recorded_at: `2026-06-19T10:00:0${i}Z`, ...x }))
    const out = tracePolyline(s, { width: 100, height: 100 })
    expect(out).toMatch(/^0\.0,100\.0 /)
    expect(out).toMatch(/100\.0,50\.0$/)
  })
  it('returns null for <2 valid samples', () => {
    expect(tracePolyline([], {})).toBeNull()
    expect(tracePolyline([{ bpm: 100, recorded_at: 'x' }], {})).toBeNull()
  })
})

describe('shortName', () => {
  it('first name + last initial', () => {
    expect(shortName('Sarah Brennan')).toBe('Sarah B.')
  })
  it('single name passes through; blank → Member', () => {
    expect(shortName('Sarah')).toBe('Sarah')
    expect(shortName('')).toBe('Member')
    expect(shortName(null)).toBe('Member')
  })
})

describe('cardModel', () => {
  const report = {
    session: { started_at: '2026-06-19T10:00:00Z', duration_seconds: 1800, class: { name: 'RIDE' } },
    summary: { effort_points: 312, avg_hr_bpm: 148, peak_hr_bpm: 181, zones: zones([60, 110, 290, 340, 200]) },
    comparisons: { vs_category: { category: 'cardio', percentile: 0.82, sample_size: 9 } },
    highlight: { message: 'Personal best for RIDE.' },
    next_action: { type: 'join', label: 'Become a member', url: 'https://b' },
  }
  it('shapes the report + extras into card fields', () => {
    const m = cardModel(report, { name: 'Sarah Brennan', tracePoints: '0,0 1,1' })
    expect(m).toMatchObject({
      name: 'Sarah B.', className: 'RIDE', points: 312, avgHr: 148, peakHr: 181, minutes: 30,
      tracePoints: '0,0 1,1', highlight: 'Personal best for RIDE.', nextAction: { url: 'https://b' },
    })
    expect(m.dominant.id).toBe(5)
    expect(m.categoryLine).toBe('Top 18% of your cardio classes')
  })
  it('renders "Top 1%" (never "Top 0%") on a best-ever category session', () => {
    // COPY-BUG regression: percentile 1 (best ever) gave 100-100 = 0 →
    // "Top 0% of your cardio classes". Must clamp to 1.
    const best = { ...report, comparisons: { vs_category: { category: 'cardio', percentile: 1, sample_size: 9 } } }
    const m = cardModel(best, { name: 'Sarah Brennan' })
    expect(m.categoryLine).toBe('Top 1% of your cardio classes')
    expect(m.categoryLine).not.toContain('Top 0%')
  })
})
