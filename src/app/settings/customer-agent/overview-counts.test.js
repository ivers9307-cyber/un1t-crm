import { describe, it, expect } from 'vitest'
import { overrideCountsBySection } from './overview-counts'

describe('overrideCountsBySection', () => {
  it('counts a mixed list per section', () => {
    const c = overrideCountsBySection(['tone', 'followups.daily_cap', 'followups.enabled', 'agent_name'])
    expect(c.followups).toBe(2)
    expect(c.personality).toBeGreaterThanOrEqual(1)
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(4)
  })
  it('counts the quiet hours pair once, in Overview', () => {
    expect(overrideCountsBySection(['quiet_hours.start', 'quiet_hours.end', 'quiet_hours.off'])).toEqual({ overview: 1 })
  })
  it('is empty for nothing overridden', () => {
    expect(overrideCountsBySection([])).toEqual({})
  })
})
