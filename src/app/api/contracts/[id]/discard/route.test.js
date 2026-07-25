// Route-level tests for POST /api/contracts/[id]/discard.
//
// CONTRACTS-DRAFT.1 — mirrors ../revoke's guard shape but is
// draft-only and NEVER emails the recipient (they never knew the
// draft existed). 401 unauthenticated, 403 non-owner/master, 404 for
// a foreign-org id (non-enumerable), 409 for any status other than
// 'draft' (including issued/viewed, which must keep going through
// /revoke instead), 200 draft -> revoked with revoked_reason 'Draft
// discarded' and no email send anywhere in the path.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contracts-email', () => ({
  sendContractRevokedEmail: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendContractRevokedEmail } from '@/lib/contracts-email'
import { logAuditEvent } from '@/lib/audit'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

const FAKE_REQUEST = new Request('https://example.com/api/contracts/c1/discard', { method: 'POST' })

// ─── DB mock ─────────────────────────────────────────────────────
//
// Discard reads:  from('contracts').select(...).eq('id', x).maybeSingle()
// Discard writes: from('contracts').update(...).eq('id',x).eq('status','draft').select().single()
function mockDb({ contract, contractError = null, updated, updatedError = null } = {}) {
  const maybeSingle = vi.fn(() =>
    Promise.resolve(contractError ? { data: null, error: contractError } : { data: contract, error: null })
  )
  const selectEq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: selectEq }))

  const single = vi.fn(() =>
    Promise.resolve(updatedError ? { data: null, error: updatedError } : { data: updated, error: null })
  )
  const updateSelect = vi.fn(() => ({ single }))
  const updateEq2 = vi.fn(() => ({ select: updateSelect }))
  const updateEq1 = vi.fn(() => ({ eq: updateEq2 }))
  const update = vi.fn((row) => ({ eq: updateEq1, __row: row }))

  const from = vi.fn((table) => {
    if (table !== 'contracts') throw new Error(`unexpected table ${table}`)
    return { select, update }
  })
  return { db: { from }, update }
}

function draftFixture(overrides = {}) {
  return {
    id: 'c1',
    profile_id: 'recipient-1',
    organization_id: ORG_A,
    location_id: LOC_A1,
    status: 'draft',
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

describe('POST /api/contracts/[id]/discard', () => {
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
  })

  it('returns 404 (not 403) for an owner of a DIFFERENT org — ids stay non-enumerable', async () => {
    getCurrentUser.mockResolvedValue(ownerOfBUser)
    createServerClient.mockReturnValue(mockDb({ contract: draftFixture() }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Not found')
  })

  it('returns 404 when the contract does not exist', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: null }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it.each(['issued', 'viewed', 'signed', 'declined', 'revoked'])(
    'returns 409 for a non-draft contract in status %s (must go through /revoke instead)',
    async (status) => {
      getCurrentUser.mockResolvedValue(masterUser)
      createServerClient.mockReturnValue(mockDb({ contract: draftFixture({ status }) }).db)
      const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
      const body = await res.json()
      expect(res.status).toBe(409)
      expect(sendContractRevokedEmail).not.toHaveBeenCalled()
      expect(body.error).toMatch(/draft/i)
    },
  )

  it("discards a draft: status -> revoked, revoked_reason 'Draft discarded', NO email", async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    const draft = draftFixture()
    const updated = {
      ...draft,
      status: 'revoked',
      revoked_at: '2026-07-25T12:00:00.000Z',
      revoked_by: 'owner-a',
      revoked_reason: 'Draft discarded',
    }
    const { db, update } = mockDb({ contract: draft, updated })
    createServerClient.mockReturnValue(db)

    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('revoked')
    expect(body.data.revoked_reason).toBe('Draft discarded')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'revoked',
      revoked_reason: 'Draft discarded',
      revoked_by: 'owner-a',
    }))
    expect(sendContractRevokedEmail).not.toHaveBeenCalled()
  })

  it('logs contract.discarded', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    const draft = draftFixture()
    const updated = { ...draft, status: 'revoked', revoked_reason: 'Draft discarded' }
    createServerClient.mockReturnValue(mockDb({ contract: draft, updated }).db)

    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'contract.discarded',
    }))
  })

  it('returns 409 when the status changed concurrently (update finds no draft row)', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: draftFixture(), updated: null }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(409)
  })

  it('surfaces a DB error on the initial read as a 500', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contractError: { message: 'boom' } }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(500)
  })
})
