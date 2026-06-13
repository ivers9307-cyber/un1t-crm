import { describe, it, expect } from 'vitest'
import { eventsLanding, EVENTS_ROUTES } from './events-hub'

describe('eventsLanding', () => {
  it('shows the chooser when the user has both surfaces', () => {
    expect(eventsLanding({ canOrders: true, canRaceControl: true })).toBe('chooser')
  })

  it('goes straight to the single surface a user has', () => {
    expect(eventsLanding({ canOrders: true, canRaceControl: false })).toBe('orders')
    expect(eventsLanding({ canOrders: false, canRaceControl: true })).toBe('races')
  })

  it('returns null when the user has neither surface', () => {
    expect(eventsLanding({ canOrders: false, canRaceControl: false })).toBe(null)
    expect(eventsLanding({})).toBe(null)
    expect(eventsLanding()).toBe(null)
  })

  it('maps every landing key to a route', () => {
    for (const key of ['orders', 'races', 'chooser']) {
      expect(typeof EVENTS_ROUTES[key]).toBe('string')
    }
    expect(EVENTS_ROUTES.chooser).toBe('/events')
  })
})
