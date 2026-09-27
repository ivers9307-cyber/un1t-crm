// TRAINERSROLE.1 — GET /api/locations/[id]/glofox-trainers judges the caller's
// role AT THE PATH LOCATION. It used to check `user.role` (the ACTIVE studio's
// role) and then membership only, so a manager at A who is staff at B read B's
// list from an A session, and a manager was refused at their own studio while
// another was active. @/lib/auth is REAL; only getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
// class-occurrences imports these four from @/lib/glofox at module scope.
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  fetchUpcomingEvents: vi.fn(),
  fetchGlofoxTrainers: vi.fn(),
  fetchMemberResult: vi.fn(),
  glofoxDisplayName: vi.fn(),
}))
vi.mock('@/lib/class-occurrences', async () => {
  const actual = await vi.importActual('@/lib/class-occurrences')
  return { ...actual, resolveTrainerNames: vi.fn() }
})

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { resolveTrainerNames } from '@/lib/class-occurrences'
import { ROLE_GATE_CASES, LOC_B, MASTER } from '../_role-gate-cases.js'

const ID1 = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const ID2 = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const CREDS = {
  branchId: 'branch-1', apiKey: 'key-1', apiToken: 'token-1',
  trainerNames: { [ID1.toUpperCase()]: '  Coach One  ' },
}

function fakeDb(rows) {
  const calls = { from: [], eq: [], gte: [] }
  const chain = {
    select: () => chain,
    eq: (col, val) => { calls.eq.push([col, val]); return chain },
    gte: (col, val) => { calls.gte.push([col, val]); return chain },
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return { calls, client: { from: (t) => { calls.from.push(t); return chain } } }
}

const call = (id) => GET({}, { params: Promise.resolve({ id }) })

describe('GET glofox-trainers — role judged at the path location', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = fakeDb([{ trainers: [ID1] }])
    createServerClient.mockReturnValue(db.client)
    glofoxCredentialsForLocation.mockResolvedValue(CREDS)
    resolveTrainerNames.mockResolvedValue({ [ID1]: 'Coach One' })
  })

  it.each(ROLE_GATE_CASES)('%s', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(glofoxCredentialsForLocation).toHaveBeenCalledWith(db.client, target)
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
      expect(db.calls.from).toEqual([])
    }
  })

  it('401s an anonymous caller before reading anything', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'unauthenticated' })
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })

  // Characterisation: passes before and after. The payload and the location
  // scoping are not part of this change.
  it('returns the distinct trainer ids for the PATH location, override first', async () => {
    db = fakeDb([
      { trainers: [ID1, ID2] },
      { trainers: [{ _id: ID1 }] },
      { trainers: ['An inline name'] },
      { trainers: null },
    ])
    createServerClient.mockReturnValue(db.client)
    resolveTrainerNames.mockResolvedValue({ [ID1]: 'Coach One', [ID2]: 'Coach Two' })
    getCurrentUser.mockResolvedValue(MASTER)

    const res = await call(LOC_B)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: {
        trainers: [
          { id: ID1, name: 'Coach One', source: 'override', classes: 2 },
          { id: ID2, name: 'Coach Two', source: 'glofox', classes: 1 },
        ],
        windowDays: 28,
      },
    })
    expect(db.calls.from).toEqual(['class_occurrences'])
    expect(db.calls.eq).toEqual([['location_id', LOC_B]])
    expect(resolveTrainerNames).toHaveBeenCalledWith(CREDS, [ID1, ID2])
  })
})
