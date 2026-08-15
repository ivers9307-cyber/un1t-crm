// SEC-LIVE-GATE.1 — /live/[locationId] rendered the coach heart-rate
// board (live HR sessions, member names) behind only login + location
// membership. No permission check at all — sibling of the /live redirect
// gap. Add the same `studio_management` gate the nav + /members hub index
// already assume (src/app/(operations)/studio-management/page.js is the
// idiom). Location membership (404, not 403 — no ID enumeration) is
// checked in addition, after the permission gate.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (user) => (user?.locations || []).map((l) => l.id),
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
}))

vi.mock('./LiveClassClient', () => ({
  default: ({ locationId, locationName }) => (
    <div data-testid="live-class-client">{locationName} / {locationId}</div>
  ),
}))

import LiveClassPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function mockDb({ location = null } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: location,
            error: location ? null : { message: 'not found' },
          })),
        })),
      })),
    })),
  }
}

function user({ isMaster = false, locations = [{ id: 'loc1' }], perms = {} } = {}) {
  return {
    id: 'u1',
    role: 'staff',
    isMaster,
    locations,
    activeLocation: locations[0] || null,
    activeAssignment: { permissions: { studio_management: false, ...perms } },
  }
}

function props(locationId = 'loc1') {
  return { params: Promise.resolve({ locationId }) }
}

beforeEach(() => vi.clearAllMocks())

describe('/live/[locationId] page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(mockDb({}))
    await expect(LiveClassPage(props())).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it('redirects to / when the user lacks studio_management, even at their own location', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { studio_management: false } }))
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc1', name: 'Stillorgan' } }))
    await expect(LiveClassPage(props('loc1'))).rejects.toThrow('NEXT_REDIRECT:/')
  })

  it('404s for a foreign location even when the user holds studio_management', async () => {
    getCurrentUser.mockResolvedValue(user({ locations: [{ id: 'loc1' }], perms: { studio_management: true } }))
    const db = mockDb({ location: { id: 'loc9', name: 'Foreign' } })
    createServerClient.mockReturnValue(db)
    await expect(LiveClassPage(props('loc9'))).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('renders the live client for an assigned location when studio_management is held', async () => {
    getCurrentUser.mockResolvedValue(user({ locations: [{ id: 'loc1' }], perms: { studio_management: true } }))
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc1', name: 'Stillorgan' } }))
    const html = renderToStaticMarkup(await LiveClassPage(props('loc1')))
    expect(html).toContain('Stillorgan')
  })

  it('masters bypass the location-membership check but still need studio_management', async () => {
    getCurrentUser.mockResolvedValue(user({ isMaster: true, locations: [], perms: { studio_management: false } }))
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc7', name: 'Anywhere' } }))
    await expect(LiveClassPage(props('loc7'))).rejects.toThrow('NEXT_REDIRECT:/')
  })
})
