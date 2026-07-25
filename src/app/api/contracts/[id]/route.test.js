// Route-level tests for GET /api/contracts/[id].
//
// SECURITY REGRESSION GUARD. The route runs as service-role (RLS
// bypassed), so before this fix it selected the contract by id alone
// and returned it to ANY authenticated caller — full body, comp
// variables, signature, signed_ip, etc. — regardless of tenant. These
// tests pin the application-layer gate: only the recipient, a master,
// or an owner of the contract's org may read it; everyone else gets a
// 404 (not 403, so existence isn't confirmed cross-tenant).
//
// We use the REAL getOwnerOrganizationIds and canTransition — only
// getCurrentUser + the Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

const FAKE_REQUEST = new Request('https://example.com/api/contracts/c1')

// ─── DB mock ─────────────────────────────────────────────────────
//
// GET reads:   from('contracts').select(...).eq('id', x).maybeSingle()
// Tick writes: from('contracts').update(...).eq('id', x).eq('status', 'issued')  (recipient + 'issued' only)

function mockDb({ contract, contractError = null } = {}) {
  const updateEq2 = vi.fn(() => Promise.resolve({ data: null, error: null }))
  const updateEq1 = vi.fn(() => ({ eq: updateEq2 }))
  const update = vi.fn(() => ({ eq: updateEq1 }))

  const maybeSingle = vi.fn(() =>
    Promise.resolve(
      contractError ? { data: null, error: contractError } : { data: contract, error: null }
    )
  )
  const selectEq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: selectEq }))

  const db = { from: vi.fn(() => ({ select, update })) }
  return { db, update }
}

// A contract owned by org A, issued to recipient-1.
function contractFixture(overrides = {}) {
  return {
    id: 'c1',
    profile_id: 'recipient-1',
    organization_id: ORG_A,
    location_id: LOC_A1,
    status: 'signed', // terminal by default → no first-view tick
    body_rendered: 'BODY',
    variables_data: { annual_salary: 50000 },
    signature_value: 'Recipient One',
    ...overrides,
  }
}

// User fixtures keyed to the contract's org (A) / a foreign org (B).
const masterUser = { id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [] }
const recipientUser = {
  id: 'recipient-1',
  isMaster: false,
  role: 'staff',
  rolesByLocation: { [LOC_B1]: 'staff' },
  locations: [{ id: LOC_B1, organization_id: ORG_B }],
}
const ownerOfAUser = {
  id: 'owner-a',
  isMaster: false,
  role: 'owner',
  rolesByLocation: { [LOC_A1]: 'owner' },
  locations: [{ id: LOC_A1, organization_id: ORG_A }],
}
const outsiderUser = {
  id: 'staff-b',
  isMaster: false,
  role: 'staff',
  rolesByLocation: { [LOC_B1]: 'staff' },
  locations: [{ id: LOC_B1, organization_id: ORG_B }],
}
const ownerOfBUser = {
  id: 'owner-b',
  isMaster: false,
  role: 'owner',
  rolesByLocation: { [LOC_B1]: 'owner' },
  locations: [{ id: LOC_B1, organization_id: ORG_B }],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/contracts/[id] — envelope', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the contract does not exist', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: null }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/contracts/[id] — authorization gate', () => {
  it('returns 404 (not 403) for a non-recipient, non-owner, non-master caller', async () => {
    // staff at tenant B asking for tenant A's contract.
    getCurrentUser.mockResolvedValue(outsiderUser)
    const { db, update } = mockDb({ contract: contractFixture() })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
    expect(body.error).toBe('Not found') // identical to the real not-found shape
    expect(body.data).toBeUndefined() // no contract body / comp data leaks
    expect(update).not.toHaveBeenCalled()
  })

  it('returns 404 for an owner of a DIFFERENT org', async () => {
    getCurrentUser.mockResolvedValue(ownerOfBUser) // owns org B; contract is org A
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(404)
  })

  it('lets the recipient read their own contract', async () => {
    getCurrentUser.mockResolvedValue(recipientUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.id).toBe('c1')
  })

  it('lets an owner of the contract org read it', async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })

  it('lets a master read any contract', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })
})

// CONTRACTS-DRAFT.1 — a draft must be invisible to its own recipient
// even though profile_id matches (they were never notified it
// exists), while the issuer side (master/owner) still needs it to
// send or discard it, and the re-issue wizard's ?from=<id> prefill
// (an owner/master fetch) must keep working.
describe('GET /api/contracts/[id] — CONTRACTS-DRAFT.1 draft visibility', () => {
  it('returns 404 (not 403) when the recipient tries to read their OWN draft', async () => {
    getCurrentUser.mockResolvedValue(recipientUser)
    const { db, update } = mockDb({ contract: contractFixture({ status: 'draft' }) })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
    expect(body.error).toBe('Not found')
    expect(body.data).toBeUndefined()
    expect(update).not.toHaveBeenCalled()
  })

  it('lets an owner of the contract org read a draft (200) — needed to send/discard it', async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture({ status: 'draft' }) }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.status).toBe('draft')
  })

  it('lets a master read a draft (200)', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture({ status: 'draft' }) }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })

  it('still 404s a foreign-org outsider on a draft (ordinary gate, unchanged)', async () => {
    getCurrentUser.mockResolvedValue(outsiderUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture({ status: 'draft' }) }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/contracts/[id] — first-view tick', () => {
  it('flips an issued contract to viewed when the recipient opens it', async () => {
    getCurrentUser.mockResolvedValue(recipientUser)
    const { db, update } = mockDb({ contract: contractFixture({ status: 'issued' }) })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledTimes(1)
    expect(body.data.status).toBe('viewed')
  })

  it('does NOT tick for a non-recipient owner/master viewing an issued contract', async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    const { db, update } = mockDb({ contract: contractFixture({ status: 'issued' }) })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    expect(update).not.toHaveBeenCalled()
  })
})
