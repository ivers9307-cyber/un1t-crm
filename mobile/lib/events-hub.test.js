import { describe, it, expect } from 'vitest'
import { eventsLanding, EVENTS_ROUTES } from './events-hub'

describe('eventsLanding', () => {
  // EVENTS-HUB.2 — Orders moved under Accounting; Events nests only Race
  // control today (a hub still, to grow when event surfaces are aligned).
  it('goes straight to Race control — the only surface today', () => {
    expect(eventsLanding({ canRaceControl: true })).toBe('races')
  })

  it('returns null when the user has no event surface', () => {
    expect(eventsLanding({ canRaceControl: false })).toBe(null)
    expect(eventsLanding({})).toBe(null)
    expect(eventsLanding()).toBe(null)
  })

  it('no longer routes to orders (it moved to the Accounting hub)', () => {
    // Passing the retired flag must not resurrect an orders landing.
    expect(eventsLanding({ canOrders: true })).toBe(null)
    expect(EVENTS_ROUTES.orders).toBeUndefined()
  })

  it('maps every landing key to a route', () => {
    for (const key of ['races', 'chooser']) {
      expect(typeof EVENTS_ROUTES[key]).toBe('string')
    }
    expect(EVENTS_ROUTES.chooser).toBe('/events')
  })
})
