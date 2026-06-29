import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [
    { _id: 'e1', name: 'S&C', time_start: 4102444800, duration: 60, size: 12, booked: 4, active: true, private: false },
  ] })),
}))
import { shapePublicClass } from './public-classes'

beforeEach(() => vi.clearAllMocks())
describe('shapePublicClass', () => {
  it('maps a glofox event to the UI shape with Dublin day + time', () => {
    const c = shapePublicClass({ _id: 'e1', name: 'S&C', time_start: 1751959800, size: 12, booked: 4 })
    expect(c.event_id).toBe('e1')
    expect(c.name).toBe('S&C')
    expect(c.spots_left).toBe(8)
    expect(c.full).toBe(false)
    expect(typeof c.day).toBe('string')
    expect(/^\d{2}:\d{2}$/.test(c.time)).toBe(true)
  })
  it('marks full when no spots', () => {
    expect(shapePublicClass({ _id: 'e', name: 'x', time_start: 1751959800, size: 5, booked: 5 }).full).toBe(true)
  })
})
