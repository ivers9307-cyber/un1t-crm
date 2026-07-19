// SAAS-3 — per-org API key auth helpers (authenticateApiKey and the
// org-scoping guards). Uses the filter-aware fake db so lookups run
// against real hashes and real row filtering — a broken filter or hash
// mismatch fails loudly instead of vacuously passing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture,
  GLOBAL_KEY, ORG1_KEY, ORG2_KEY_REVOKED, UNKNOWN_KEY,
} from './api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import {
  authenticateApiKey, requireApiKeyOrManager,
  orgScopeLocationIds, assertRowInOrg, assertCreateInOrg, orgLocationIds,
} from './api-auth.js'
import { getCurrentUser } from './auth.js'

const req = (token) =>
  new Request('http://localhost/api/anything', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

let tables

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  tables = twoOrgFixture()
  db = makeFakeDb(tables)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authenticateApiKey', () => {
  it('legacy shared CRM_API_KEY → ok, unscoped (orgId null, legacy)', async () => {
    const auth = await authenticateApiKey(req(GLOBAL_KEY))
    expect(auth).toEqual({ ok: true, orgId: null, legacy: true })
  })

  it('active per-org key → ok with the key\'s organization', async () => {
    const auth = await authenticateApiKey(req(ORG1_KEY))
    expect(auth.ok).toBe(true)
    expect(auth.orgId).toBe('org-1')
    expect(auth.legacy).toBe(false)
    expect(auth.keyId).toBe('key-1')
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

  it('legacy shared key → ok, unscoped — behaviour unchanged', async () => {
    const auth = await requireApiKeyOrManager(req(GLOBAL_KEY))
    expect(auth).toEqual({ ok: true, user: null, orgId: null })
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('revoked per-org key falls through to cookie auth and 401s', async () => {
    const auth = await requireApiKeyOrManager(req(ORG2_KEY_REVOKED))
    expect(auth.ok).toBe(false)
    expect(auth.response.status).toBe(401)
    expect(getCurrentUser).toHaveBeenCalled()
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

  it('falsy orgId → null (legacy key / cookie callers stay unfiltered)', async () => {
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

  it('no-op when orgId is falsy (legacy key)', async () => {
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

  it('no-op when orgId is falsy (legacy key)', async () => {
    expect(await assertCreateInOrg({ db, orgId: null })).toBeNull()
  })
})

describe('orgLocationIds', () => {
  it('returns only the org\'s location ids', async () => {
    expect(await orgLocationIds(db, 'org-1')).toEqual(['loc-1a', 'loc-1b'])
    expect(await orgLocationIds(db, 'org-empty')).toEqual([])
  })
})
