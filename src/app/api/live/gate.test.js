// SEC-LIVE-API.1 — the gate matrix for the WHOLE /api/live/** family.
//
// One file, every route, so a new route in this family that forgets the guard
// is a one-line addition away from being caught. Each route is asserted on
// three properties:
//
//   1. anonymous            → 401
//   2. member of ANOTHER location → 403, with a database client that THROWS if
//      touched (proves the refusal happens before any lookup, so it cannot
//      confirm whether the location or any row exists)
//   3. member of THIS location WITHOUT `studio_management` → 403, same
//      untouched-database proof. This is the case that shipped broken: the
//      /live page redirects these users, the API served them.
//
// Plus, for the mutation routes, a permitted non-coach → 403, and for every
// route a permitted caller → NOT refused.
//
// The session-end route is keyed by a session id rather than a location, so it
// gets its own no-enumeration block below.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Mirror the real helper (src/lib/auth.js) so the fixtures below are the
  // single source of truth for who is a member of what.
  getUserLocationIds: vi.fn((user) => (user?.locations || []).map((l) => l.id)),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/live-class', () => ({
  getLiveSessions: vi.fn(async () => []),
  getAvailableStraps: vi.fn(async () => []),
  endAllAtLocation: vi.fn(async () => ({ ended: 0 })),
  endSession: vi.fn(async () => ({ ok: true, summary: {} })),
  pairOverride: vi.fn(async () => ({ ok: true, sessionId: 's1' })),
}))
vi.mock('@/lib/class-bookings', () => ({
  getClassRoster: vi.fn(async () => ({ occurrence: null, roster: [] })),
  mergeRosterWithSessions: vi.fn(() => []),
}))
vi.mock('@/lib/hr-detections', () => ({ resolveDetectionLinks: vi.fn(async () => []) }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

import { GET as liveGET } from './[locationId]/route'
import { GET as contactsGET } from './[locationId]/contacts/route'
import { GET as detectionsGET } from './[locationId]/detections/route'
import { GET as visitsGET } from './[locationId]/detection-visits/route'
import { POST as endAllPOST } from './[locationId]/end-all/route'
import { POST as pairPOST } from './[locationId]/pair/route'
import { POST as testModePOST, DELETE as testModeDELETE } from './[locationId]/test-mode/route'
import { POST as registerPOST, DELETE as registerDELETE } from './[locationId]/register-device/route'
import { POST as sessionEndPOST } from './sessions/[id]/end/route'

const LOC = 'loc1'
const OTHER = 'loc2'
const props = { params: Promise.resolve({ locationId: LOC }) }

function userAt(locationId, role, { studio = true } = {}) {
  return {
    id: 'u1',
    role,
    isMaster: false,
    locations: [{ id: locationId, features: {} }],
    assignmentsByLocation: {
      [locationId]: { role, permissions: studio === null ? {} : { studio_management: studio } },
    },
    roleTemplatesByLocation: {},
  }
}

/** A client that fails the test if the route reaches the database at all. */
function throwingDb() {
  return { from: () => { throw new Error('database touched before the gate refused') } }
}

/** Permissive chain — every builder method returns itself; terminals resolve empty. */
function chainDb() {
  const chain = new Proxy({}, {
    get(_t, prop) {
      // Thenable, not a Promise — the supabase-js builder shape.
      if (prop === 'then') return (...a) => Promise.resolve({ data: [], error: null }).then(...a)
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve({ data: null, error: null })
      return () => chain
    },
  })
  return { from: () => chain }
}

function jsonReq(body = {}) {
  return new Request(`http://localhost/api/live/${LOC}/x`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
function getReq(qs = '') {
  return new Request(`http://localhost/api/live/${LOC}/x${qs}`)
}

// [label, handler, requestFactory, isMutation]
const ROUTES = [
  ['GET /api/live/[locationId]', liveGET, () => getReq(), false],
  ['GET .../contacts', contactsGET, () => getReq('?q=a'), false],
  ['GET .../detections', detectionsGET, () => getReq(), false],
  ['GET .../detection-visits', visitsGET, () => getReq('?detection_id=d1'), false],
  ['POST .../end-all', endAllPOST, () => jsonReq(), true],
  ['POST .../pair', pairPOST, () => jsonReq({ device_key: 'ant:1', contact_id: 'c1', bridge_id: 'b1' }), true],
  ['POST .../test-mode', testModePOST, () => jsonReq({ minutes: 10 }), true],
  ['DELETE .../test-mode', testModeDELETE, () => jsonReq(), true],
  ['POST .../register-device', registerPOST, () => jsonReq({ device_key: 'ant:1', contact_id: '00000000-0000-0000-0000-000000000001' }), true],
  ['DELETE .../register-device', registerDELETE, () => jsonReq({ device_key: 'ant:1', contact_id: '00000000-0000-0000-0000-000000000001' }), true],
]

beforeEach(() => { vi.clearAllMocks() })

describe.each(ROUTES)('%s — gate', (_label, handler, makeReq, isMutation) => {
  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(throwingDb())
    expect((await handler(makeReq(), props)).status).toBe(401)
  })

  it('403s a staffer whose location is elsewhere, without touching the database', async () => {
    getCurrentUser.mockResolvedValue(userAt(OTHER, 'owner'))
    createServerClient.mockReturnValue(throwingDb())
    expect((await handler(makeReq(), props)).status).toBe(403)
  })

  it('403s a member of this location who lacks studio_management', async () => {
    // head_coach on the code default — the real Stillorgan population.
    getCurrentUser.mockResolvedValue(userAt(LOC, 'head_coach', { studio: null }))
    createServerClient.mockReturnValue(throwingDb())
    expect((await handler(makeReq(), props)).status).toBe(403)
  })

  it('403s a member with an explicit studio_management: false', async () => {
    getCurrentUser.mockResolvedValue(userAt(LOC, 'manager', { studio: false }))
    createServerClient.mockReturnValue(throwingDb())
    expect((await handler(makeReq(), props)).status).toBe(403)
  })

  it('does NOT refuse a permitted caller', async () => {
    // Asserting "not refused" rather than 200: each route's own test file
    // covers its payload. What matters here is that the gate let them past.
    getCurrentUser.mockResolvedValue(userAt(LOC, 'head_coach', { studio: true }))
    createServerClient.mockReturnValue(chainDb())
    const res = await handler(makeReq(), props)
    expect([401, 403]).not.toContain(res.status)
  })

  if (isMutation) {
    it('403s a permitted staff member (no coach role)', async () => {
      getCurrentUser.mockResolvedValue(userAt(LOC, 'staff', { studio: true }))
      createServerClient.mockReturnValue(throwingDb())
      expect((await handler(makeReq(), props)).status).toBe(403)
    })
  }
})

describe('POST /api/live/sessions/[id]/end — no existence oracle', () => {
  const sessionProps = { params: Promise.resolve({ id: 'sess1' }) }
  const coach = () => userAt(LOC, 'head_coach', { studio: true })

  function dbReturning(session) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: session, error: null }) }) }) }),
    }
  }

  it('404s a session id that does not exist', async () => {
    getCurrentUser.mockResolvedValue(coach())
    createServerClient.mockReturnValue(dbReturning(null))
    expect((await sessionEndPOST(jsonReq(), sessionProps)).status).toBe(404)
  })

  it('404s — not 403s — a real session at a location the caller cannot reach', async () => {
    getCurrentUser.mockResolvedValue(coach())
    createServerClient.mockReturnValue(dbReturning({ id: 'sess1', location_id: OTHER }))
    expect((await sessionEndPOST(jsonReq(), sessionProps)).status).toBe(404)
  })

  it('404s a real session at the caller’s own location when they lack studio_management', async () => {
    getCurrentUser.mockResolvedValue(userAt(LOC, 'head_coach', { studio: null }))
    createServerClient.mockReturnValue(dbReturning({ id: 'sess1', location_id: LOC }))
    expect((await sessionEndPOST(jsonReq(), sessionProps)).status).toBe(404)
  })

  it('returns an identical body for missing and foreign sessions', async () => {
    getCurrentUser.mockResolvedValue(coach())
    createServerClient.mockReturnValue(dbReturning(null))
    const missing = await (await sessionEndPOST(jsonReq(), sessionProps)).text()
    createServerClient.mockReturnValue(dbReturning({ id: 'sess1', location_id: OTHER }))
    const foreign = await (await sessionEndPOST(jsonReq(), sessionProps)).text()
    expect(foreign).toBe(missing)
  })

  it('403s a non-coach role before the lookup (leaks nothing about the id)', async () => {
    getCurrentUser.mockResolvedValue(userAt(LOC, 'staff', { studio: true }))
    createServerClient.mockReturnValue(throwingDb())
    expect((await sessionEndPOST(jsonReq(), sessionProps)).status).toBe(403)
  })

  it('ends the session for a permitted coach at its location', async () => {
    getCurrentUser.mockResolvedValue(coach())
    createServerClient.mockReturnValue(dbReturning({ id: 'sess1', location_id: LOC }))
    const res = await sessionEndPOST(jsonReq(), sessionProps)
    expect(res.status).toBe(200)
  })
})
