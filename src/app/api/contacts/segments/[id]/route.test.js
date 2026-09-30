// Route-level test for the location gate, demonstrated against
// /api/contacts/segments/[id]. Establishes the pattern for testing
// any session-auth route's authn/authz behaviour without standing
// up real Supabase / Next infrastructure.
//
// The pattern in three steps:
//   1. vi.mock('@/lib/auth')     — control getCurrentUser's return.
//   2. vi.mock('@/lib/supabase') — return a chainable mock that
//                                  resolves to whatever the test needs
//                                  for the row-existence + update calls.
//   3. Call the imported PUT/DELETE handler directly with a fabricated
//      Request and { params } object. Assert on the response status +
//      body.
//
// The location-gate path under test:
//   PUT /api/contacts/segments/[id] looks up the segment, then calls
//   assertLocationAccessOr404(user, existing.location_id). If the user
//   isn't a member of the segment's location, the route returns 404
//   (so cross-tenant IDs can't be enumerated).
//   The test we care most about is the IDOR case: a user authenticated
//   to location A trying to mutate a segment in location B.
//
// SEGMENTROUTE.1: the route also checks the Contacts permission at the
// segment's studio (callers carry a role there), reads email_sequences to see
// whether a sequence starts from the segment (the mock answers per table),
// reads the row with maybeSingle, and 404s a non-uuid id before any read (ids
// are uuid-shaped).
//
// Co-located alongside the route file (src/app/api/.../route.test.js)
// — vitest.config.js's `include` glob picks these up automatically.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mocks — these MUST be set up before importing the route.
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Real assertLocationAccess — we want to test that the route uses
  // the gate correctly, not that the gate's internal logic works
  // (that's covered in src/lib/auth.test.js). Pass through to the
  // real impl by re-importing.
  assertLocationAccess: (user, locationId) => {
    // Inline reproduction of the real helper — fine because the helper
    // is pure and tiny. Avoids a circular re-import dance with vi.mock.
    if (!user) {
      // Mimic NextResponse.json — the route only checks for truthy
      // return, not the actual structure, but tests assert on it.
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden — location not in your assignments' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
    return null
  },
  // assertLocationAccessOr404 — same gate but returns 404 on the
  // forbidden branch so cross-tenant IDs can't be enumerated.
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

import { PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const SEG = '5e000000-0000-4000-8000-0000000000d1'

// The row lookup is from('contact_segments').select().eq().maybeSingle();
// the sequence-use read is from('email_sequences').select(…, {count, head}).eq().in().eq();
// the update is .update().eq().select().single(); the delete .delete().eq().
function mockDb({ existingSegment = null, sequencesUsing = 0, updateResult = null, deleteResult = null }) {
  const lookupMaybeSingle = vi.fn(() => Promise.resolve({ data: existingSegment, error: null }))
  const updateSingle = vi.fn(() => Promise.resolve(updateResult || { data: null, error: null }))
  const updateUpdate = vi.fn(() => ({ eq: () => ({ select: () => ({ single: updateSingle }) }) }))
  const deleteDelete = vi.fn(() => ({ eq: () => Promise.resolve(deleteResult || { error: null }) }))
  const seqChain = {
    eq: () => seqChain,
    in: () => seqChain,
    then: (res, rej) => Promise.resolve({ data: null, count: sequencesUsing, error: null }).then(res, rej),
  }
  const db = {
    from: vi.fn((table) => (table === 'email_sequences'
      ? { select: () => seqChain }
      : { select: () => ({ eq: () => ({ maybeSingle: lookupMaybeSingle }) }), update: updateUpdate, delete: deleteDelete })),
  }
  return { db, spies: { lookupMaybeSingle, updateUpdate, deleteDelete } }
}

function makeRequest(body) {
  // Minimal Web Fetch Request stand-in. The route only needs .json().
  return new Request('http://test/api/contacts/segments/test-id', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset()
  vi.mocked(createServerClient).mockReset()
})

describe('PUT /api/contacts/segments/[id] — location gate', () => {
  // Body that satisfies the Zod UpdateBody schema and the audience
  // validator (PUT runs validateAudienceFilter since SEGMENTROUTE.1).
  const validBody = {
    name: 'My segment',
    filter: { logic: 'and', filters: [] },
  }

  it('returns 401 when there is no authenticated user', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const { db } = mockDb({ existingSegment: { id: SEG, location_id: 'loc-a' } })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await PUT(makeRequest(validBody), { params: { id: SEG } })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Unauthorised' })
  })

  it('returns 404 when the segment does not exist', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'p1',
      locations: [{ id: 'loc-a', role: 'owner' }],
    })
    const { db } = mockDb({ existingSegment: null })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await PUT(makeRequest(validBody), { params: { id: SEG } })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/not found/i)
  })

  it('returns 404 when the segment belongs to a location the user is NOT a member of (IDOR attempt)', async () => {
    // The case we care about most. User is authenticated and assigned
    // to loc-a. They try to update a segment that lives in loc-b. Route
    // must reject.
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'p1',
      locations: [{ id: 'loc-a', role: 'owner' }],
    })
    const { db, spies } = mockDb({
      existingSegment: { id: SEG, location_id: 'loc-b' },
    })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await PUT(makeRequest(validBody), { params: { id: SEG } })
    expect(res.status).toBe(404)
    // No update should have been attempted.
    expect(spies.updateUpdate).not.toHaveBeenCalled()
  })

  it('proceeds to update when the user has access to the segment’s location', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'p1',
      locations: [{ id: 'loc-a', role: 'owner' }],
    })
    const { db, spies } = mockDb({
      existingSegment: { id: SEG, location_id: 'loc-a' },
      updateResult: {
        data: { id: SEG, location_id: 'loc-a', name: 'My segment' },
        error: null,
      },
    })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await PUT(makeRequest(validBody), { params: { id: SEG } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.segment).toMatchObject({ id: SEG, name: 'My segment' })
    expect(spies.updateUpdate).toHaveBeenCalledTimes(1)
  })

  it('master users (every active location loaded) pass the gate naturally', async () => {
    // Master gets every active location surfaced into user.locations
    // by getCurrentUser. The gate is an array-membership check so a
    // master can edit segments at any location without special-casing
    // in the route.
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'master-1',
      role: 'master',
      locations: [{ id: 'loc-a' }, { id: 'loc-b' }, { id: 'loc-c' }],
    })
    const { db, spies } = mockDb({
      existingSegment: { id: SEG, location_id: 'loc-c' }, // master not formally assigned via profile_locations
      updateResult: {
        data: { id: SEG, location_id: 'loc-c', name: 'My segment' },
        error: null,
      },
    })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await PUT(makeRequest(validBody), { params: { id: SEG } })
    expect(res.status).toBe(200)
    expect(spies.updateUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('DELETE /api/contacts/segments/[id] — location gate', () => {
  it('returns 404 on cross-tenant delete attempt (no DELETE issued)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'p1',
      locations: [{ id: 'loc-a', role: 'owner' }],
    })
    const { db, spies } = mockDb({
      existingSegment: { id: SEG, location_id: 'loc-b' },
    })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await DELETE(
      new Request('http://test/api/contacts/segments/s1', { method: 'DELETE' }),
      { params: { id: SEG } }
    )
    expect(res.status).toBe(404)
    expect(spies.deleteDelete).not.toHaveBeenCalled()
  })

  it('proceeds with delete when the user has access', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'p1',
      locations: [{ id: 'loc-a', role: 'owner' }],
    })
    const { db, spies } = mockDb({
      existingSegment: { id: SEG, location_id: 'loc-a' },
      deleteResult: { error: null },
    })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await DELETE(
      new Request('http://test/api/contacts/segments/s1', { method: 'DELETE' }),
      { params: { id: SEG } }
    )
    expect(res.status).toBe(200)
    expect(spies.deleteDelete).toHaveBeenCalledTimes(1)
  })

  it('returns 401 with no authenticated user (no DB lookup)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    // Even though the test won't reach the lookup, give it a stub.
    const { db } = mockDb({ existingSegment: null })
    vi.mocked(createServerClient).mockReturnValue(db)

    const res = await DELETE(
      new Request('http://test/api/contacts/segments/s1', { method: 'DELETE' }),
      { params: { id: SEG } }
    )
    expect(res.status).toBe(401)
  })
})
