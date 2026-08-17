import { describe, it, expect } from 'vitest'
import { pickRecapHighlight, recapModel } from './wrapped.js'

const baseSummary = {
  effort_points: 42,
  avg_hr_bpm: 148,
  peak_hr_bpm: 181,
  zones: [
    { id: 1, name: 'Warm-up', color: '#9CA3AF', seconds: 120, percent: 0.1 },
    { id: 4, name: 'Threshold', color: '#F59E0B', seconds: 600, percent: 0.5 },
    { id: 5, name: 'Max', color: '#EF4444', seconds: 180, percent: 0.15 },
  ],
}

describe('pickRecapHighlight', () => {
  it('prefers the report highlight message', () => {
    const out = pickRecapHighlight({ highlight: { message: 'Deep in the red zone.' }, summary: baseSummary })
    expect(out).toEqual({ kind: 'highlight', message: 'Deep in the red zone.' })
  })

  it('surfaces a personal best from vs_category at percentile 1.0', () => {
    const out = pickRecapHighlight({
      summary: baseSummary,
      comparisons: { vs_category: { percentile: 1.0, sample_size: 6, category: 'RIDE' } },
    })
    expect(out.kind).toBe('pb')
    expect(out.message).toMatch(/Personal best/)
    expect(out.message).toMatch(/RIDE/)
  })

  it('gives a Top N% brag for a high (but not best) percentile', () => {
    const out = pickRecapHighlight({
      summary: baseSummary,
      comparisons: { vs_category: { percentile: 0.8, sample_size: 5, category: 'RIDE' } },
    })
    expect(out).toEqual({ kind: 'top', message: 'Top 20% of your RIDE classes.' })
  })

  it('floors the Top N% brag at 1%', () => {
    const out = pickRecapHighlight({
      summary: baseSummary,
      comparisons: { vs_category: { percentile: 0.994, sample_size: 5, category: 'RIDE' } },
    })
    expect(out.message).toBe('Top 1% of your RIDE classes.')
  })

  it('ignores vs_category with too small a sample', () => {
    const out = pickRecapHighlight({
      summary: { ...baseSummary, burn: false },
      comparisons: { vs_category: { percentile: 1.0, sample_size: 1, category: 'RIDE' } },
    })
    expect(out).toBeNull()
  })

  it('falls back to the Burn when nothing better exists', () => {
    const out = pickRecapHighlight({ summary: { ...baseSummary, burn: true, z4plus_minutes: 13 } })
    expect(out).toEqual({ kind: 'burn', message: 'The Burn — 13 min in Zone 4+.' })
  })

  it('returns a generic Burn message when minutes are missing', () => {
    const out = pickRecapHighlight({ summary: { burn: true } })
    expect(out).toEqual({ kind: 'burn', message: 'The Burn earned.' })
  })

  it('returns null for a plain session', () => {
    expect(pickRecapHighlight({ summary: { effort_points: 10, burn: false } })).toBeNull()
  })

  it('is total on empty / undefined input', () => {
    expect(pickRecapHighlight()).toBeNull()
    expect(pickRecapHighlight({})).toBeNull()
  })
})

describe('recapModel', () => {
  it('flattens the report and derives Zone 4+ minutes when absent', () => {
    const m = recapModel(
      { summary: baseSummary, session: { calories_kcal: 512.6, class: { name: 'RIDE 45' } } },
      [{ bpm: 120 }, { bpm: 150 }, { bpm: null }, { bpm: 170 }],
    )
    expect(m.points).toBe(42)
    expect(m.avgHr).toBe(148)
    expect(m.peakHr).toBe(181)
    expect(m.calories).toBe(513)
    expect(m.className).toBe('RIDE 45')
    // 600 + 180 = 780s → 13 min
    expect(m.z4plusMinutes).toBe(13)
    expect(m.z4plusSeconds).toBe(780)
    expect(m.dominant.id).toBe(5) // highest zone above threshold
    expect(m.hasTrace).toBe(true)
    expect(m.traceSamples).toHaveLength(3) // null bpm dropped
  })

  it('prefers an explicit z4plus_minutes over the derived value', () => {
    const m = recapModel({ summary: { ...baseSummary, z4plus_minutes: 9 } })
    expect(m.z4plusMinutes).toBe(9)
  })

  it('defaults points to 0 and marks no trace for a bare report', () => {
    const m = recapModel({})
    expect(m.points).toBe(0)
    expect(m.hasTrace).toBe(false)
    expect(m.dominant.color).toBeTruthy()
  })

  it('needs at least two samples for a trace', () => {
    expect(recapModel({ summary: baseSummary }, [{ bpm: 120 }]).hasTrace).toBe(false)
  })
})
