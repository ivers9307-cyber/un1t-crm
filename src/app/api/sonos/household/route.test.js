// A household id that Sonos answers 410/404 for is a re-link state, not an
// outage: the route answers the not-connected shape so the page offers
// Reconnect. Every other failed read keeps the reachable:false path.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/sonos/client', () => ({
  isHouseholdGone: (c) => c === 410 || c === 404,
  getSonosConfig: vi.fn(),
  withFreshToken: vi.fn(),
  sonosGetGroups: vi.fn(),
  sonosGetFavorites: vi.fn(),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosGetFavorites } from '@/lib/sonos/client'

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'loc-1' } })
  getSonosConfig.mockReturnValue({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://x/cb' })
  withFreshToken.mockResolvedValue({ ok: true, token: 'tok', householdId: 'HH1' })
  sonosGetFavorites.mockResolvedValue({ ok: true, statusCode: 200, body: { items: [] } })
})

describe('GET /api/sonos/household — failed groups read', () => {
  it.each([410, 404])('%i answers connected:false / household_gone', async (statusCode) => {
    sonosGetGroups.mockResolvedValue({ ok: false, statusCode, body: null })
    const body = await (await GET()).json()
    expect(body).toEqual({ success: true, connected: false, reason: 'household_gone', statusCode })
  })

  it.each([503, 401, 0])('%i stays connected:true / reachable:false', async (statusCode) => {
    sonosGetGroups.mockResolvedValue({ ok: false, statusCode, body: null })
    const body = await (await GET()).json()
    expect(body).toEqual({ success: true, connected: true, reachable: false, statusCode })
  })
})
