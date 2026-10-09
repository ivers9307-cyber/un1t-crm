import { describe, it, expect, vi } from 'vitest'
import { orgLocationIdsFor } from './inbound-contact-match'

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
