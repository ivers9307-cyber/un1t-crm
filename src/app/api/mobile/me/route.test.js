// TZ.14 — /api/mobile/me carries each location's timezone, so the phone can
// show a record in its studio's zone (D3) and take the roster's "today" on the
// studio's calendar. The value is the canonical zone, with the Europe/Dublin
// floor for a NULL or invalid column (zoneOfLocation, TZ.1).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

import { getCurrentUser } from '@/lib/auth'
import { GET } from './route.js'

const DUB = { id: 'loc-dub', name: 'Studio A', slug: 'a', country: 'IE', timezone: 'Europe/Dublin', features: {} }
const NY = { id: 'loc-ny', name: 'Studio B', slug: 'b', country: 'US', timezone: 'America/New_York', features: {} }
const LEGACY = { id: 'loc-null', name: 'Studio C', slug: 'c', country: 'IE', timezone: null, features: {} }
const BAD = { id: 'loc-bad', name: 'Studio D', slug: 'd', country: 'IE', timezone: '+05:00', features: {} }

function user(over = {}) {
  return {
    id: 'u1', full_name: 'Staff One', email: 'staff@example.test', role: 'manager',
    locations: [DUB, NY, LEGACY, BAD],
    activeLocation: NY,
    assignmentsByLocation: {},
    ...over,
  }
}

beforeEach(() => {
  db = makeFakeDb({ mobile_bar_prefs: [] })
  getCurrentUser.mockReset()
})

describe('GET /api/mobile/me — timezone (TZ.14)', () => {
  it('every location and the active location carry the studio zone', async () => {
    getCurrentUser.mockResolvedValue(user())
    const { data } = await (await GET()).json()
    const zones = Object.fromEntries(data.locations.map((l) => [l.id, l.timezone]))
    expect(zones['loc-dub']).toBe('Europe/Dublin')
    expect(zones['loc-ny']).toBe('America/New_York')
    expect(data.activeLocation.timezone).toBe('America/New_York')
  })

  it('a NULL or invalid column answers the Europe/Dublin floor, never a raw value', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocation: BAD }))
    const { data } = await (await GET()).json()
    const zones = Object.fromEntries(data.locations.map((l) => [l.id, l.timezone]))
    expect(zones['loc-null']).toBe('Europe/Dublin')
    expect(zones['loc-bad']).toBe('Europe/Dublin')
    expect(data.activeLocation.timezone).toBe('Europe/Dublin')
  })

  it('no active location stays null; signed out stays 401', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocation: null }))
    expect((await (await GET()).json()).data.activeLocation).toBe(null)
    getCurrentUser.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
  })
})
