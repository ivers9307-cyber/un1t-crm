import { describe, it, expect } from 'vitest'
import { sharedEventsOrFilter } from './event-visibility'

const A1 = '11111111-1111-1111-1111-1111111111a1'
const A2 = '11111111-1111-1111-1111-1111111111a2'
const X  = '22222222-2222-2222-2222-222222222222'

describe('sharedEventsOrFilter (W0.3)', () => {
  it('own location OR shared events owned by a sibling of the same organisation', () => {
    expect(sharedEventsOrFilter(A1, [A1, A2]))
      .toBe(`location_id.eq.${A1},and(shared.eq.true,location_id.in.(${A1},${A2}))`)
  })
  it('a location with no known organisation sees its own events only', () => {
    expect(sharedEventsOrFilter(X, [])).toBe(`location_id.eq.${X}`)
  })
  // The string is a filter DSL built by interpolation: ids are shape-checked.
  it('throws on a non-uuid locationId rather than interpolating it', () => {
    expect(() => sharedEventsOrFilter('loc-a1,shared.eq.true', [A1])).toThrow('non-uuid location id')
    expect(() => sharedEventsOrFilter(undefined, [A1])).toThrow('non-uuid location id')
  })
  it('drops a malformed org id instead of interpolating it', () => {
    expect(sharedEventsOrFilter(A1, [A1, 'x),location_id.neq.(y', A2]))
      .toBe(`location_id.eq.${A1},and(shared.eq.true,location_id.in.(${A1},${A2}))`)
    expect(sharedEventsOrFilter(A1, ['nope'])).toBe(`location_id.eq.${A1}`)
  })
})
