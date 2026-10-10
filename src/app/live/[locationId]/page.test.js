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
  default: ({ locationId, locationName, tvToken }) => (
    <div data-testid="live-class-client" data-tv-token={tvToken || undefined}>{locationName} / {locationId}</div>
  ),
}))

import LiveClassPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

/**
 * Two tables: `locations` (the name lookup, `.single()`) and, since
 * LIVE-TVBTN.1, `tv_displays` (the TV-link token, a filtered list). The
 * tv_displays chain records every `.eq()` so a test can assert the query was
 * scoped to the location the page admitted. `displays` is what that list
 * resolves to; `displaysError` makes it fail.
 */
function mockDb({ location = null, displays = [], displaysError = null } = {}) {
  const displayEqs = []
  const displaysChain = {
    eq: vi.fn((col, val) => { displayEqs.push([col, val]); return displaysChain }),
    order: vi.fn(() => displaysChain),
    limit: vi.fn(() => Promise.resolve({ data: displaysError ? null : displays, error: displaysError })),
  }
  const db = {
    displayEqs,
    from: vi.fn((table) => {
      if (table === 'tv_displays') return { select: vi.fn(() => displaysChain) }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: location,
              error: location ? null : { message: 'not found' },
            })),
          })),
        })),
      }
    }),
  }
  return db
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
    await expect(LiveClassPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to / when the user lacks studio_management, even at their own location', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { studio_management: false } }))
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc1', name: 'Stillorgan' } }))
    await expect(LiveClassPage(props('loc1'))).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('404s for a foreign location even when the user holds studio_management', async () => {
    getCurrentUser.mockResolvedValue(user({ locations: [{ id: 'loc1' }], perms: { studio_management: true } }))
    const db = mockDb({ location: { id: 'loc9', name: 'Foreign' }, displays: [{ token: 'tok-foreign' }] })
    createServerClient.mockReturnValue(db)
    await expect(LiveClassPage(props('loc9'))).rejects.toThrow('NEXT_NOT_FOUND')
    // LIVE-TVBTN.1 — the token query sits BEHIND the gate: a caller outside
    // the location never even reaches the tv_displays read.
    expect(db.from).not.toHaveBeenCalledWith('tv_displays')
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
    await expect(LiveClassPage(props('loc7'))).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
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
    await expect(LiveClassPage(props('loc2'))).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
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

// LIVE-TVBTN.1 — the "TV display" link's token. W0.9c removed the
// location-keyed /tv/<locationId> board (and with it the link); the board is
// /tv/live/<token> now, so the page loads the location's oldest ACTIVE
// tv_displays row and hands its token to the client. No active display →
// null → no link. The query is scoped to the admitted location.
describe('/live/[locationId] — tvToken', () => {
  const permitted = () => user({ locations: [{ id: 'loc1' }], perms: { studio_management: true } })

  it("passes the location's active display token, queried by location_id + active", async () => {
    getCurrentUser.mockResolvedValue(permitted())
    const db = mockDb({ location: { id: 'loc1', name: 'Stillorgan' }, displays: [{ token: 'tok-stillorgan-tv1' }] })
    createServerClient.mockReturnValue(db)
    const el = await LiveClassPage(props('loc1'))
    expect(el.props.tvToken).toBe('tok-stillorgan-tv1')
    expect(db.displayEqs).toEqual([['location_id', 'loc1'], ['active', true]])
    expect(renderToStaticMarkup(el)).toContain('data-tv-token="tok-stillorgan-tv1"')
  })

  it('passes null when the location has no active display (no dead link)', async () => {
    getCurrentUser.mockResolvedValue(permitted())
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc1', name: 'Stillorgan' }, displays: [] }))
    const el = await LiveClassPage(props('loc1'))
    expect(el.props.tvToken).toBeNull()
    expect(renderToStaticMarkup(el)).not.toContain('data-tv-token')
  })

  it('still renders the board (token null) when the tv_displays read fails', async () => {
    getCurrentUser.mockResolvedValue(permitted())
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    createServerClient.mockReturnValue(
      mockDb({ location: { id: 'loc1', name: 'Stillorgan' }, displaysError: { message: 'boom' } }),
    )
    const el = await LiveClassPage(props('loc1'))
    expect(el.props.tvToken).toBeNull()
    expect(renderToStaticMarkup(el)).toContain('Stillorgan')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

// C116 GATES-2 — End, Pair, test mode and Claim call routes that also need a
// coach role (LIVE_MUTATION_ROLES) at this location. The page decides it
// where the routes do and hands the client `canMutate`; the board itself
// stays open to everyone with studio_management.
describe('/live/[locationId] — canMutate', () => {
  const withRole = (role) => {
    const u = user({ locations: [{ id: 'loc1' }], perms: { studio_management: true } })
    u.role = role
    u.assignmentsByLocation.loc1.role = role
    u.activeAssignment.role = role
    return u
  }
  it.each([
    ['staff (main: End/Pair shown, then 403)', 'staff', false],
    ['head coach', 'head_coach', true],
    ['manager', 'manager', true],
  ])('%s', async (_label, role, expected) => {
    getCurrentUser.mockResolvedValue(withRole(role))
    createServerClient.mockReturnValue(mockDb({ location: { id: 'loc1', name: 'Stillorgan' } }))
    const el = await LiveClassPage(props('loc1'))
    expect(el.props.canMutate).toBe(expected)
  })
})
