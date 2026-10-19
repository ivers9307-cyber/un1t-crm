// UN1TWRITE.15 — which un1t.online studios the contact page offers a booking card for.
import { describe, it, expect } from 'vitest'
import { un1tBookingStudios } from './contact-page-gates'

const HATCH = 'loc-hatch'
const STILL = 'loc-still'
const user = (...ids) => ({ id: 'u', isMaster: false, locations: ids.map((id) => ({ id })) })
const locations = (writes = true) => [
  { id: HATCH, name: 'Hatch Street', membership_source: 'un1t_online', writes_enabled: writes },
  { id: STILL, name: 'Stillorgan', membership_source: 'glofox', writes_enabled: false },
]

describe('un1tBookingStudios', () => {
  it('a dual-studio contact gives Hatch only to Hatch members; a Stillorgan-only viewer gets none', () => {
    const clientRows = [{ location_id: HATCH }]
    expect(un1tBookingStudios({ user: user(HATCH), clientRows, locations: locations() })).toEqual([{ locationId: HATCH, studioName: 'Hatch Street' }])
    expect(un1tBookingStudios({ user: user(STILL), clientRows, locations: locations() })).toEqual([])
    expect(un1tBookingStudios({ user: { ...user(), isMaster: true }, clientRows, locations: locations() })).toHaveLength(1)
  })

  it('writes off, no client row, or a Glofox studio gives none', () => {
    expect(un1tBookingStudios({ user: user(HATCH), clientRows: [{ location_id: HATCH }], locations: locations(false) })).toEqual([])
    expect(un1tBookingStudios({ user: user(HATCH), clientRows: [], locations: locations() })).toEqual([])
    expect(un1tBookingStudios({ user: user(STILL), clientRows: [{ location_id: STILL }], locations: locations() })).toEqual([])
    expect(un1tBookingStudios({ user: user(HATCH), clientRows: [{ location_id: HATCH }, { location_id: HATCH }], locations: locations() })).toHaveLength(1)
  })
})
