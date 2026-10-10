// SAAS-3 — per-org API key auth helpers (authenticateApiKey and the
// org-scoping guards). Uses the filter-aware fake db so lookups run
// against real hashes and real row filtering — a broken filter or hash
// mismatch fails loudly instead of vacuously passing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture,
  RETIRED_SHARED_KEY, ORG1_KEY, ORG2_KEY_REVOKED, UNKNOWN_KEY,
} from './api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import {
  authenticateApiKey, requireApiKeyOrManager,
  orgScopeLocationIds, assertRowInOrg, assertCreateInOrg, assertProfileInOrg, orgLocationIds,
} from './api-auth.js'
import { getCurrentUser } from './auth.js'

const req = (token) =>
  new Request('http://localhost/api/anything', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

let tables

beforeEach(() => {
  vi.clearAllMocks()
  tables = twoOrgFixture()
  db = makeFakeDb(tables)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authenticateApiKey', () => {
  // APIKEYS.4 — the shared integration key's path was removed. The
  // old env vars are deliberately SET here (Vercel's copies are unset only
  // after the deploy), so the refusal proves the code no longer reads them.
  it('APIKEYS.4 — the retired shared key is refused (401) even with both old envs set', async () => {
    vi.stubEnv('CRM_API_KEY', RETIRED_SHARED_KEY)
    vi.stubEnv('CRM_API_KEY_ORG_ID', 'org-1')
    const auth = await authenticateApiKey(req(RETIRED_SHARED_KEY))
    expect(auth.ok).toBe(false)
    expect(auth.response.status).toBe(401)
  })

  it('active per-org key → ok with the key\'s organization', async () => {
    const auth = await authenticateApiKey(req(ORG1_KEY))
    expect(auth.ok).toBe(true)
    expect(auth).toEqual({ ok: true, orgId: 'org-1', keyId: 'key-1' })
  })

  it('revoked per-org key → 401', async () => {
    const auth = await authenticateApiKey(req(ORG2_KEY_REVOKED))
    expect(auth.ok).toBe(false)
    expect(auth.response.status).toBe(401)
  })

  it('unknown unitk_ token → 401', async () => {
    const auth = await authenticateApiKey(req(UNKNOWN_KEY))
    expect(auth.ok).toBe(false)
    expect(auth.response.status).toBe(401)
  })

  it('missing bearer token → 401', async () => {
    const auth = await authenticateApiKey(req(null))
    expect(auth.ok).toBe(false)
    expect(auth.response.status).toBe(401)
  })
})

describe('requireApiKeyOrManager', () => {
  it('per-org key → ok with orgId, no user, no cookie lookup', async () => {
    const auth = await requireApiKeyOrManager(req(ORG1_KEY))
    expect(auth).toEqual({ ok: true, user: null, orgId: 'org-1' })
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('APIKEYS.4 — the retired shared key is no credential: falls through to cookie auth and 401s', async () => {
    vi.stubEnv('CRM_API_KEY', RETIRED_SHARED_KEY)
    vi.stubEnv('CRM_API_KEY_ORG_ID', 'org-1')
    const auth = await requireApiKeyOrManager(req(RETIRED_SHARED_KEY))
    expect(auth.ok).toBe(false)
    expect(auth.response.status).toBe(401)
    expect(getCurrentUser).toHaveBeenCalled()
  })

  it('revoked per-org key falls through to cookie auth and 401s', async () => {
    const auth = await requireApiKeyOrManager(req(ORG2_KEY_REVOKED))
    expect(auth.ok).toBe(false)
    expect(auth.response.status).toBe(401)
    expect(getCurrentUser).toHaveBeenCalled()
  })

  // ROLESWEEP.2 — the cookie branch is a COARSE pre-check: Manager+ at ANY
  // location, never the role at the ACTIVE studio (`user.role`). Each route
  // decides at its target (tests/role-sweep/api-key-or-manager.test.js).
  describe('cookie branch (no bearer token)', () => {
    const cookieUser = (rolesByLocation, activeId, extra = {}) => ({
      id: 'user-1', profileRole: 'staff', rolesByLocation,
      locations: Object.keys(rolesByLocation).map((id) => ({ id })),
      activeLocation: activeId ? { id: activeId } : null,
      role: rolesByLocation[activeId], ...extra,
    })

    it('staff at the ACTIVE studio, manager at another → ok (main: 401)', async () => {
      const user = cookieUser({ 'loc-a': 'staff', 'loc-b': 'manager' }, 'loc-a')
      getCurrentUser.mockResolvedValue(user)
      expect(await requireApiKeyOrManager(req(null))).toEqual({ ok: true, user, orgId: null })
    })

    it('head coach at the active studio → ok (unchanged)', async () => {
      const user = cookieUser({ 'loc-a': 'head_coach' }, 'loc-a')
      getCurrentUser.mockResolvedValue(user)
      expect((await requireApiKeyOrManager(req(null))).ok).toBe(true)
    })

    it('Manager+ nowhere → 401 (unchanged)', async () => {
      getCurrentUser.mockResolvedValue(cookieUser({ 'loc-a': 'staff', 'loc-b': 'reception' }, 'loc-a'))
      const auth = await requireApiKeyOrManager(req(null))
      expect(auth.ok).toBe(false)
      expect(auth.response.status).toBe(401)
    })

    it('a master (profileRole) with no per-location roles → ok (unchanged)', async () => {
      getCurrentUser.mockResolvedValue(cookieUser({}, null, { profileRole: 'master', role: 'master' }))
      expect((await requireApiKeyOrManager(req(null))).ok).toBe(true)
    })

    it('a `user.role` of manager with no per-location role anywhere → 401 (0 such profiles in prod, 28 Sep)', async () => {
      getCurrentUser.mockResolvedValue(cookieUser({}, null, { role: 'manager' }))
      expect((await requireApiKeyOrManager(req(null))).ok).toBe(false)
    })

    it('no session → 401 (unchanged)', async () => {
      getCurrentUser.mockResolvedValue(null)
      expect((await requireApiKeyOrManager(req(null))).ok).toBe(false)
    })
  })
})

describe('orgScopeLocationIds', () => {
  // Returns ids for the CALLER to apply — never the builder itself.
  // (Its predecessor scopeQueryToOrg async-returned the builder, and
  // `await` assimilates thenables: the query executed mid-chain and
  // later .limit()/.eq() calls threw on the plain response object.)
  it('returns the org\'s location ids for a scoped caller', async () => {
    expect(await orgScopeLocationIds(db, 'org-1')).toEqual(['loc-1a', 'loc-1b'])
  })

  it('org with zero locations gets the match-nothing sentinel, never unfiltered', async () => {
    expect(await orgScopeLocationIds(db, 'org-empty')).toEqual(['00000000-0000-0000-0000-000000000000'])
  })

  it('falsy orgId → null (cookie callers stay unfiltered)', async () => {
    expect(await orgScopeLocationIds(db, null)).toBeNull()
  })

  it('applied ids really filter a two-org table', async () => {
    let query = db.from('bookings').select('*')
    const orgLocs = await orgScopeLocationIds(db, 'org-1')
    if (orgLocs) query = query.in('location_id', orgLocs)
    const { data } = await query
    expect(data.map((b) => b.id)).toEqual(['b1'])
  })
})

describe('assertRowInOrg', () => {
  it('null (allowed) for a row inside the org', async () => {
    expect(await assertRowInOrg({ db, orgId: 'org-1', table: 'bookings', id: 'b1' })).toBeNull()
  })

  it('404 for another org\'s row — id existence not confirmed', async () => {
    const res = await assertRowInOrg({ db, orgId: 'org-1', table: 'bookings', id: 'b2' })
    expect(res.status).toBe(404)
  })

  it('404 for a missing row', async () => {
    const res = await assertRowInOrg({ db, orgId: 'org-1', table: 'bookings', id: 'nope' })
    expect(res.status).toBe(404)
  })

  it('no-op when orgId is falsy (cookie callers)', async () => {
    expect(await assertRowInOrg({ db, orgId: null, table: 'bookings', id: 'b2' })).toBeNull()
  })
})

describe('assertCreateInOrg', () => {
  it('allows a create targeting the org\'s own location', async () => {
    expect(await assertCreateInOrg({ db, orgId: 'org-1', locationId: 'loc-1b' })).toBeNull()
  })

  it('403s a create targeting another org\'s location', async () => {
    const res = await assertCreateInOrg({ db, orgId: 'org-1', locationId: 'loc-2a' })
    expect(res.status).toBe(403)
  })

  it('resolves the location via contactId and blocks cross-org contacts', async () => {
    expect(await assertCreateInOrg({ db, orgId: 'org-1', contactId: 'c1' })).toBeNull()
    const res = await assertCreateInOrg({ db, orgId: 'org-1', contactId: 'c2' })
    expect(res.status).toBe(403)
  })

  it('400s when no location is resolvable for a per-org key', async () => {
    const res = await assertCreateInOrg({ db, orgId: 'org-1' })
    expect(res.status).toBe(400)
  })

  it('no-op when orgId is falsy (cookie caller)', async () => {
    expect(await assertCreateInOrg({ db, orgId: null })).toBeNull()
  })

  // W0.1b — with BOTH supplied, the contact used to be ignored entirely: a
  // key could create at its own location against another org's contact id.
  it('404s when the location is in the org but the contact is another org\'s (both supplied)', async () => {
    const res = await assertCreateInOrg({ db, orgId: 'org-1', locationId: 'loc-1a', contactId: 'c2' })
    expect(res.status).toBe(404)
  })

  it('404s when the location is in the org but the contact does not exist (both supplied)', async () => {
    const res = await assertCreateInOrg({ db, orgId: 'org-1', locationId: 'loc-1a', contactId: 'nope' })
    expect(res.status).toBe(404)
  })

  it('allows when both the location and the contact are in the org', async () => {
    expect(await assertCreateInOrg({ db, orgId: 'org-1', locationId: 'loc-1b', contactId: 'c1' })).toBeNull()
  })

  it('still 403s a cross-org location even when the contact is in the org', async () => {
    const res = await assertCreateInOrg({ db, orgId: 'org-1', locationId: 'loc-2a', contactId: 'c1' })
    expect(res.status).toBe(403)
  })
})

// W0.1b — a referenced profile id (task assignee) must belong to the org:
// a staff row at one of its locations, or an org-admin row for it.
describe('assertProfileInOrg', () => {
  it('null (allowed) for staff at one of the org\'s locations', async () => {
    expect(await assertProfileInOrg({ db, orgId: 'org-1', profileId: 'p1' })).toBeNull()
  })

  it('null (allowed) for the org\'s org admin (profile_organizations, no location row)', async () => {
    expect(await assertProfileInOrg({ db, orgId: 'org-1', profileId: 'padmin1' })).toBeNull()
  })

  it('404 for staff of another org — existence not confirmed', async () => {
    const res = await assertProfileInOrg({ db, orgId: 'org-1', profileId: 'p2' })
    expect(res.status).toBe(404)
  })

  it('404 for an unknown profile id', async () => {
    const res = await assertProfileInOrg({ db, orgId: 'org-1', profileId: 'nope' })
    expect(res.status).toBe(404)
  })

  it('no-op when orgId is falsy (cookie caller)', async () => {
    expect(await assertProfileInOrg({ db, orgId: null, profileId: 'p2' })).toBeNull()
  })
})

describe('orgLocationIds', () => {
  it('returns only the org\'s location ids', async () => {
    expect(await orgLocationIds(db, 'org-1')).toEqual(['loc-1a', 'loc-1b'])
    expect(await orgLocationIds(db, 'org-empty')).toEqual([])
  })
})
