// Route-level tests for POST /api/contracts/[id]/resend.
//
// Mirrors the org-scoping/status-gate conventions of ../revoke and
// the fixture shape of ../route.test.js: 401 unauthenticated, 403
// non-owner/master, 404 for a foreign-org id (non-enumerable — same
// shape as a missing row), 409 once the contract has moved past
// issued/viewed, 200 re-firing the issue-notification email
// otherwise. This route never mutates the contract row, so there's
// no update-call assertion the way revoke's tests have one.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contracts-email', () => ({ sendContractIssuedEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendContractIssuedEmail } from '@/lib/contracts-email'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

const FAKE_REQUEST = new Request('https://example.com/api/contracts/c1/resend', { method: 'POST' })

// ─── DB mock ─────────────────────────────────────────────────────
//
// Resend reads: from('contracts').select(...).eq('id', x).maybeSingle()
// and never writes to the contracts table at all.
function mockDb({ contract, contractError = null } = {}) {
  const maybeSingle = vi.fn(() =>
    Promise.resolve(contractError ? { data: null, error: contractError } : { data: contract, error: null })
  )
  const selectEq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: selectEq }))
  const db = { from: vi.fn(() => ({ select })) }
  return { db }
}

function contractFixture(overrides = {}) {
  return {
    id: 'c1',
    profile_id: 'recipient-1',
    organization_id: ORG_A,
    location_id: LOC_A1,
    status: 'issued',
    profile: { full_name: 'Jane Doe', email: 'jane@example.com' },
    issuer: { full_name: 'Richard Ivers' },
    template: { name: 'FTE Contract' },
    ...overrides,
  }
}

const masterUser = { id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [] }
const ownerOfAUser = {
  id: 'owner-a', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_A1]: 'owner' },
  locations: [{ id: LOC_A1, organization_id: ORG_A }],
}
const ownerOfBUser = {
  id: 'owner-b', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_B1]: 'owner' },
  locations: [{ id: LOC_B1, organization_id: ORG_B }],
}
const staffAtAUser = {
  id: 'staff-a', isMaster: false, role: 'staff',
  rolesByLocation: { [LOC_A1]: 'staff' },
  locations: [{ id: LOC_A1, organization_id: ORG_A }],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/contracts/[id]/resend', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-owner/master caller', async () => {
    getCurrentUser.mockResolvedValue(staffAtAUser)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.error).toBe('Master or owner only')
    expect(sendContractIssuedEmail).not.toHaveBeenCalled()
  })

  it('returns 404 (not 403) for an owner of a DIFFERENT org — ids stay non-enumerable', async () => {
    getCurrentUser.mockResolvedValue(ownerOfBUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Not found')
    expect(sendContractIssuedEmail).not.toHaveBeenCalled()
  })

  it('returns 404 when the contract does not exist', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: null }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('returns 409 for a signed contract', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture({ status: 'signed' }) }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(409)
    expect(sendContractIssuedEmail).not.toHaveBeenCalled()
  })

  it('returns 409 for a revoked contract', async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture({ status: 'revoked' }) }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(409)
  })

  it('re-sends the issue email for an issued contract and returns success', async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.warning).toBeUndefined()
    expect(sendContractIssuedEmail).toHaveBeenCalledTimes(1)
    expect(sendContractIssuedEmail).toHaveBeenCalledWith(expect.objectContaining({
      recipient: { full_name: 'Jane Doe', email: 'jane@example.com' },
    }))
  })

  it('also re-sends for a viewed contract (master caller)', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture({ status: 'viewed' }) }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })

  it('surfaces an email-send failure as a warning without failing the request', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    sendContractIssuedEmail.mockResolvedValueOnce({ ok: false, error: 'Postmark down' })
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.warning).toMatch(/Postmark down/)
  })

  it('surfaces a DB error as a 500', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contractError: { message: 'boom' } }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(500)
  })
})
