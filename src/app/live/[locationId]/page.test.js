// SEC-LIVE-GATE.1 — /live/[locationId] rendered the coach heart-rate
// board (live HR sessions, member names) behind only login + location
// membership. No permission check at all — sibling of the /live redirect
// gap. Add the same `studio_management` gate the nav + /members hub index
// already assume (src/app/(operations)/studio-management/page.js is the
// idiom). Location membership (404, not 403 — no ID enumeration) is
// checked in addition.
//
// SEC-LIVE-API.2 — the gate now resolves at the TARGET location
// (`hasPermissionForLocation`), not the caller's active one. SEC-LIVE-API.1
// moved the routes this page polls onto the target location and left the page
// on `hasPermission`, which made the PAGE the softer half of its own gate:
// a multi-location operator permitted at their active location could open the
// board for a location where they are denied, and watch every ~2s poll 403.

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

/**
 * getCurrentUser()-shaped. `perms` is the per-location override bag applied at
 * EVERY location in `locations`; `permsByLocation` overrides it per location so
 * a test can build the active-vs-target divergence. Both `activeAssignment`
 * (what `hasPermission` reads) and `assignmentsByLocation` (what
 * `hasPermissionForLocation` reads) are populated, so a test that sets them to
 * disagree is genuinely exercising which one the page consults.
 */
function user({ isMaster = false, locations = [{ id: 'loc1' }], perms = {}, permsByLocation = {} } = {}) {
  const permsAt = (id) => ({ studio_management: false, ...perms, ...(permsByLocation[id] || {}) })
  return {
    id: 'u1',
    role: isMaster ? 'master' : 'staff',
    isMaster,
    locations,
    activeLocation: locations[0] || null,
    activeAssignment: locations[0]
      ? { role: 'staff', permissions: permsAt(locations[0].id) }
      : null,
    assignmentsByLocation: Object.fromEntries(
      locations.map((l) => [l.id, { role: 'staff', permissions: permsAt(l.id) }]),
    ),
    roleTemplatesByLocation: {},
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

  it('masters bypass the location-membership check', async () => {
    getCurrentUser.mockResolvedValue(user({ isMaster: true, locations: [] }))
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc7', name: 'Anywhere' } }))
    const html = renderToStaticMarkup(await LiveClassPage(props('loc7')))
    expect(html).toContain('Anywhere')
  })

  // Tier 1 runs BEFORE the master short-circuit in resolvePermission, so a
  // location that switches the feature off denies everyone. Two real prod
  // locations carry `features.studio_management: false` (CCF Autos, SourceIt).
  it('honours the tier-1 location feature gate, even for a master', async () => {
    getCurrentUser.mockResolvedValue(
      user({ isMaster: true, locations: [{ id: 'loc7', features: { studio_management: false } }] }),
    )
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc7', name: 'CCF Autos' } }))
    await expect(LiveClassPage(props('loc7'))).rejects.toThrow('NEXT_REDIRECT:/')
  })

  // The SEC-LIVE-API.2 defect, in the shape prod actually had it: permitted at
  // the ACTIVE location, explicitly denied at the TARGET one. Before the fix
  // this rendered the board shell and then 403'd on every poll.
  it('redirects when the caller is permitted at their ACTIVE location but denied at the target', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        locations: [{ id: 'loc1' }, { id: 'loc2' }],
        permsByLocation: {
          loc1: { studio_management: true },   // active location — page gate used to stop here
          loc2: { studio_management: false },  // the board actually being opened
        },
      }),
    )
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc2', name: 'Stillorgan' } }))
    await expect(LiveClassPage(props('loc2'))).rejects.toThrow('NEXT_REDIRECT:/')
  })

  // The same alignment in the other direction: denied where they are standing,
  // permitted at the board they opened. The API would serve them, so the page
  // must not turn them away.
  it('renders when the caller is denied at their ACTIVE location but permitted at the target', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        locations: [{ id: 'loc1' }, { id: 'loc2' }],
        permsByLocation: {
          loc1: { studio_management: false },
          loc2: { studio_management: true },
        },
      }),
    )
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc2', name: 'Stillorgan' } }))
    const html = renderToStaticMarkup(await LiveClassPage(props('loc2')))
    expect(html).toContain('Stillorgan')
  })
})
