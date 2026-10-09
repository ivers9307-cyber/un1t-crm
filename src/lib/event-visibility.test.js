import { describe, it, expect } from 'vitest'
import { sharedEventsOrFilter } from './event-visibility'

describe('sharedEventsOrFilter (W0.3)', () => {
  it('own location OR shared events owned by a sibling of the same organisation', () => {
    expect(sharedEventsOrFilter('loc-a1', ['loc-a1', 'loc-a2']))
      .toBe('location_id.eq.loc-a1,and(shared.eq.true,location_id.in.(loc-a1,loc-a2))')
  })
  it('a location with no known organisation sees its own events only', () => {
    expect(sharedEventsOrFilter('loc-x', [])).toBe('location_id.eq.loc-x')
  })
})
