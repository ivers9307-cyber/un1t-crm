import { describe, it, expect } from 'vitest'
import { pickCommsLocationTarget } from './event-comms-location'

describe('pickCommsLocationTarget', () => {
  it('uses the explicit override when set (wins over everything)', () => {
    expect(pickCommsLocationTarget(
      { sending_location_id: 'L1', host_id: 'h', location_id: 'anchor' }, 'MASTER',
    )).toBe('L1')
  })

  it('uses the org master for a host event with no override', () => {
    expect(pickCommsLocationTarget(
      { host_id: 'h', location_id: 'anchor' }, 'MASTER',
    )).toBe('MASTER')
  })

  it('falls back to the event location (anchor) when a host event has no master', () => {
    expect(pickCommsLocationTarget(
      { host_id: 'h', location_id: 'anchor' }, null,
    )).toBe('anchor')
  })

  it('uses the event location for a normal (non-host) event', () => {
    expect(pickCommsLocationTarget(
      { location_id: 'L2' }, null,
    )).toBe('L2')
  })

  it('returns null for a null event', () => {
    expect(pickCommsLocationTarget(null, 'MASTER')).toBeNull()
  })
})
