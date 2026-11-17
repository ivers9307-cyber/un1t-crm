// INBOXASSIGN.1 — the owner filter travels in the list URL ('any' never does).
import { describe, it, expect } from 'vitest'
import { buildMailUrl } from './mail-vocabulary'

describe('buildMailUrl owner', () => {
  it('sends mine / unassigned and omits any', () => {
    expect(buildMailUrl({ locationId: 'l1', owner: 'mine' })).toBe('/api/email/mail?location_id=l1&owner=mine')
    expect(buildMailUrl({ locationId: 'l1', owner: 'unassigned' })).toBe('/api/email/mail?location_id=l1&owner=unassigned')
    expect(buildMailUrl({ locationId: 'l1', owner: 'any' })).toBe('/api/email/mail?location_id=l1')
    expect(buildMailUrl({ locationId: 'l1' })).toBe('/api/email/mail?location_id=l1')
  })
})
