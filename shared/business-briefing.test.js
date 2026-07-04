// shared/business-briefing.test.js
import { describe, it, expect } from 'vitest'
import { buildBusinessBriefing } from './business-briefing.js'

const base = {
  revenue: { totalCents: 3840000, deltaPct: 6 },
  members: { count: 312, netChange: 9 },
  attention: [
    { label: '5 in arrears (€1,240)' },
    { label: '2 going quiet' },
    { label: '1 approval waiting' },
  ],
}

describe('buildBusinessBriefing', () => {
  it('positive deltas → upbeat opener with revenue, delta, members', () => {
    const s = buildBusinessBriefing(base)
    expect(s).toContain('€38,400')
    expect(s).toContain('+6%')
    expect(s).toContain('312 members')
    expect(s).toContain('+9')
    expect(s.startsWith('Solid')).toBe(true)
  })

  it('lists at most three attention items after "Watch:"', () => {
    const s = buildBusinessBriefing({
      ...base,
      attention: [
        { label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' },
      ],
    })
    expect(s).toContain('Watch: a, b, c.')
    // The 4th attention item ('d') must be dropped. Assert on the Watch
    // clause itself — a bare not.toContain('d') is a false failure here
    // because the fixed opener text ("Solid", "MTD") legitimately contains
    // the letter 'd'.
    expect(s).not.toContain('a, b, c, d')
    expect(s.endsWith('Watch: a, b, c.')).toBe(true)
  })

  it('negative revenue delta → steadier opener', () => {
    const s = buildBusinessBriefing({
      ...base,
      revenue: { totalCents: 3840000, deltaPct: -4 },
    })
    expect(s.startsWith('Mixed')).toBe(true)
    expect(s).toContain('-4%')
  })

  it('no attention items → "Nothing urgent." closer', () => {
    const s = buildBusinessBriefing({ ...base, attention: [] })
    expect(s).toContain('Nothing urgent.')
  })

  it('null deltas render without the delta clause and never throw', () => {
    const s = buildBusinessBriefing({
      revenue: { totalCents: 0, deltaPct: null },
      members: { count: 0, netChange: null },
      attention: [],
    })
    expect(typeof s).toBe('string')
    expect(s).not.toContain('null')
    expect(s).not.toContain('NaN')
  })
})
