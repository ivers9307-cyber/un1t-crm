import { describe, it, expect, vi } from 'vitest'
import { orgLocationIdsFor, scopeFor, NO_SCOPE_SENTINEL } from './inbound-contact-match'

vi.mock('./sibling-locations', () => ({
  siblingLocationIds: vi.fn(async (_db, locationId) =>
    locationId === 'loc-a1' ? { ids: ['loc-a2'], error: null } : { ids: [], error: { message: 'boom' } }),
}))

describe('orgLocationIdsFor (W0.2)', () => {
  it('returns the receiving location plus its organisation siblings', async () => {
    expect(await orgLocationIdsFor({}, 'loc-a1')).toEqual(['loc-a1', 'loc-a2'])
  })
  it('narrows to the receiving location alone when the sibling lookup fails', async () => {
    expect(await orgLocationIdsFor({}, 'loc-b1')).toEqual(['loc-b1'])
  })
  it('an empty location id yields no scope at all (callers must then match nothing)', async () => {
    expect(await orgLocationIdsFor({}, null)).toEqual([])
  })
})

describe('scopeFor (W0.2)', () => {
  it('passes a non-empty scope through unchanged', () => {
    expect(scopeFor(['loc-a1', 'loc-a2'])).toEqual(['loc-a1', 'loc-a2'])
  })
  it('pins an empty scope to the sentinel so the filter matches nothing', () => {
    expect(scopeFor([])).toEqual([NO_SCOPE_SENTINEL])
  })
})
