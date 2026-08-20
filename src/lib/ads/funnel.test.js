import { describe, it, expect } from 'vitest'
import { shapeFunnel, FUNNEL_STAGES } from './funnel.js'

describe('shapeFunnel', () => {
  // STARTCONV.1 — the picker now comes BEFORE the details form, so `slots`
  // sits second and is close to `view` (it is the landing step), while
  // `details` is where the real drop happens. The old fixture had details
  // above slots, which is the shape that would render as broken data.
  it('is a 4-stage class funnel and computes conversion + drop-off', () => {
    const counts = [
      { step: 'view', sessions: 100 },
      { step: 'path_class', sessions: 40 },   // legacy rows still land here…
      { step: 'path_consult', sessions: 20 }, // …but no longer form a stage
      { step: 'slots_view', sessions: 90 },
      { step: 'details', sessions: 30 },
      { step: 'booked_class', sessions: 9 },
      { step: 'booked_consult', sessions: 4 }, // upsell adds — NOT counted in the funnel
    ]
    const s = shapeFunnel(counts)
    expect(s.map((x) => [x.key, x.sessions])).toEqual([
      ['view', 100], ['slots', 90], ['details', 30], ['booked', 9],
    ])
    expect(s[0].pctOfTop).toBe(100)
    expect(s[1].pctOfTop).toBe(90) // 90 / 100
    expect(s[3].pctOfTop).toBe(9)  // 9 / 100 — booked_class only, no double-count
    expect(s[1].dropFromPrev).toBe(10) // 1 - 90/100
    expect(s[2].dropFromPrev).toBe(67) // 1 - 30/90 → 0.667 → 67
    expect(s[3].dropFromPrev).toBe(70) // 1 - 9/30
  })

  it('handles no traffic yet (empty)', () => {
    const s = shapeFunnel([])
    expect(s).toHaveLength(4)
    expect(s.every((x) => x.sessions === 0)).toBe(true)
    expect(s[0].pctOfTop).toBe(0)
    expect(s[1].dropFromPrev).toBe(0)
  })

  it('handles a null argument', () => {
    expect(shapeFunnel(null)).toHaveLength(4)
  })

  it('exposes the ordered stages', () => {
    expect(FUNNEL_STAGES[0].key).toBe('view')
    expect(FUNNEL_STAGES[3].key).toBe('booked')
    expect(FUNNEL_STAGES[3].steps).toEqual(['booked_class'])
  })
})
