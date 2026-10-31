// TRAINERSROLE.1 — GET /api/locations/[id]/glofox-memberships judges the
// caller's role AT THE PATH LOCATION, not via `user.role` (the ACTIVE studio's
// role). Same gate and same fix as glofox-trainers. @/lib/auth is REAL; only
// getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
// GLOFOXPRIVATE.1 — the learned private rows are read through the catalogue module.
vi.mock('@/lib/glofox-catalog', () => ({ learnedPrivateMemberships: vi.fn(async () => ({ rows: [], error: null })) }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  listGlofoxMemberships: vi.fn(),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { glofoxCredentialsForLocation, listGlofoxMemberships } from '@/lib/glofox'
import { learnedPrivateMemberships } from '@/lib/glofox-catalog'
import { ROLE_GATE_CASES, LOC_B, MASTER } from '../_role-gate-cases.js'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'

const MEMBERSHIPS = [{ _id: 'm-1', name: 'Trial', plans: [{ code: 'p-1' }] }]
const PUBLIC = MEMBERSHIPS.map(m => ({ ...m, private: false }))
const call = (id) => GET({}, { params: Promise.resolve({ id }) })

describe('GET glofox-memberships — role judged at the path location', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'branch-1', apiKey: 'key-1', apiToken: 'token-1' })
    listGlofoxMemberships.mockResolvedValue({ ok: true, memberships: MEMBERSHIPS })
    learnedPrivateMemberships.mockResolvedValue({ rows: [], error: null })
  })

  it.each(ROLE_GATE_CASES)('%s', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(await res.json()).toEqual({ success: true, memberships: PUBLIC, count: 1 })
      expect(glofoxCredentialsForLocation).toHaveBeenCalledWith(expect.anything(), target)
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
      expect(listGlofoxMemberships).not.toHaveBeenCalled()
    }
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })
})

describe('GET glofox-memberships — REGISTRYREAD.1b unreadable settings', () => {
  it('answers 503 glofox_settings_unreadable and never calls Glofox', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const res = await call(LOC_B)
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j).toEqual({ success: false, error: GLOFOX_SETTINGS_UNREADABLE, message: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    expect(listGlofoxMemberships).not.toHaveBeenCalled()
  })

  it('a location with no Glofox still answers 400 glofox_not_configured', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: null })
    const res = await call(LOC_B)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('glofox_not_configured')
  })
})

// GLOFOXPRIVATE.1 (mig 796) — Glofox's list hides private memberships; the ones
// the sync learned by id are appended, and a failed read of them is said.
describe('GET glofox-memberships — learned private memberships', () => {
  const ELITES = { _id: '68b17bbd4e9e83430f0ddcdc', name: '1) The Elites Trial', active: true, private: true, plans: [{ code: '1756461990251', type: 'num_classes', price: 0, name: 'The Elites Trial' }] }

  beforeEach(() => {
    vi.clearAllMocks()
    getCurrentUser.mockResolvedValue(MASTER)
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'branch-1', apiKey: 'key-1', apiToken: 'token-1' })
    listGlofoxMemberships.mockResolvedValue({ ok: true, memberships: MEMBERSHIPS })
  })

  it('appends the learned private rows after the live public ones, excluding ids the list returned', async () => {
    learnedPrivateMemberships.mockResolvedValue({ rows: [ELITES], error: null })
    const res = await call(LOC_B)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, memberships: [...PUBLIC, ELITES], count: 2 })
    const [, loc, exclude] = learnedPrivateMemberships.mock.calls[0]
    expect(loc).toBe(LOC_B)
    expect([...exclude]).toEqual(['m-1'])
  })

  it('a failed read of the learned rows still answers the live list and says private_unread', async () => {
    learnedPrivateMemberships.mockResolvedValue({ rows: [], error: 'down' })
    const res = await call(LOC_B)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, memberships: PUBLIC, count: 1, private_unread: true })
  })
})
