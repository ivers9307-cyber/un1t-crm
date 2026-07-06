import { describe, it, expect } from 'vitest'
import { shapeFunnel, FUNNEL_STAGES } from './funnel.js'

describe('shapeFunnel', () => {
  it('collapses path/booked variants and computes conversion + drop-off', () => {
    const counts = [
      { step: 'view', sessions: 100 },
      { step: 'path_class', sessions: 40 },
      { step: 'path_consult', sessions: 20 },
      { step: 'details', sessions: 30 },
      { step: 'slots_view', sessions: 28 },
      { step: 'booked_class', sessions: 8 },
      { step: 'booked_consult', sessions: 2 },
    ]
    const s = shapeFunnel(counts)
    expect(s.map((x) => [x.key, x.sessions])).toEqual([
      ['view', 100], ['path', 60], ['details', 30], ['slots', 28], ['booked', 10],
    ])
    expect(s[0].pctOfTop).toBe(100)
    expect(s[1].pctOfTop).toBe(60) // 60 / 100
    expect(s[4].pctOfTop).toBe(10) // 10 / 100
    expect(s[1].dropFromPrev).toBe(40) // 1 - 60/100
    expect(s[2].dropFromPrev).toBe(50) // 1 - 30/60
  })

  it('handles no traffic yet (empty)', () => {
    const s = shapeFunnel([])
    expect(s).toHaveLength(5)
    expect(s.every((x) => x.sessions === 0)).toBe(true)
    expect(s[0].pctOfTop).toBe(0)
    expect(s[1].dropFromPrev).toBe(0)
  })

  it('handles a null argument', () => {
    expect(shapeFunnel(null)).toHaveLength(5)
  })

  it('exposes the ordered stages', () => {
    expect(FUNNEL_STAGES[0].key).toBe('view')
    expect(FUNNEL_STAGES[4].steps).toContain('booked_consult')
  })
})
