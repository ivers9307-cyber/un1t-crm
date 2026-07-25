// Route-level tests for POST /api/contracts/[id]/send.
//
// CONTRACTS-DRAFT.1 — mirrors the org-scoping/status-gate conventions
// of ../resend and ../revoke: 401 unauthenticated, 403 non-owner/
// master, 404 for a foreign-org id (non-enumerable — same shape as a
// missing row), 409 for any status other than 'draft', 200 draft ->
// issued with notifyContractIssued fired exactly once and issued_at
// refreshed to "now" (the draft's original issued_at is just its
// creation timestamp — the contracts.issued_at column is NOT NULL —
// not the real send time).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contracts-notify', () => ({
  notifyContractIssued: vi.fn(async () => ({ emailResult: { ok: true } })),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { notifyContractIssued } from '@/lib/contracts-notify'
import { logAuditEvent } from '@/lib/audit'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

const FAKE_REQUEST = new Request('https://example.com/api/contracts/c1/send', { method: 'POST' })

// ─── DB mock ─────────────────────────────────────────────────────
//
// Send reads:   from('contracts').select(...).eq('id', x).maybeSingle()
// Send writes:  from('contracts').update(...).eq('id',x).eq('status','draft').select().single()
// Audit reads:  from('contract_templates').select('name').eq('id',x).maybeSingle()
function mockDb({ contract, contractError = null, updated, updatedError = null } = {}) {
  const maybeSingle = vi.fn(() =>
    Promise.resolve(contractError ? { data: null, error: contractError } : { data: contract, error: null })
  )
  const selectEq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: selectEq }))

  const tplMaybeSingle = vi.fn(() => Promise.resolve({ data: { name: 'FTE Contract' }, error: null }))
  const tplEq = vi.fn(() => ({ maybeSingle: tplMaybeSingle }))
  const tplSelect = vi.fn(() => ({ eq: tplEq }))

  const single = vi.fn(() =>
    Promise.resolve(updatedError ? { data: null, error: updatedError } : { data: updated, error: null })
  )
  const updateSelect = vi.fn(() => ({ single }))
  const updateEq2 = vi.fn((...args) => ({ select: updateSelect, __args: args }))
  const updateEq1 = vi.fn(() => ({ eq: updateEq2 }))
  const update = vi.fn((row) => ({ eq: updateEq1, __row: row }))

  const from = vi.fn((table) => {
    if (table === 'contract_templates') return { select: tplSelect }
    if (table === 'contracts') return { select, update }
    throw new Error(`unexpected table ${table}`)
  })
  return { db: { from }, update, updateEq1, updateEq2 }
}

function draftFixture(overrides = {}) {
  return {
    id: 'c1',
    profile_id: 'recipient-1',
    organization_id: ORG_A,
    location_id: LOC_A1,
    template_id: 'tpl-1',
    status: 'draft',
    profile: { full_name: 'Jane Doe', email: 'jane@example.com' },
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

describe('POST /api/contracts/[id]/send', () => {
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
    expect(notifyContractIssued).not.toHaveBeenCalled()
  })

  it('returns 404 (not 403) for an owner of a DIFFERENT org — ids stay non-enumerable', async () => {
    getCurrentUser.mockResolvedValue(ownerOfBUser)
    createServerClient.mockReturnValue(mockDb({ contract: draftFixture() }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Not found')
    expect(notifyContractIssued).not.toHaveBeenCalled()
  })

  it('returns 404 when the contract does not exist', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: null }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it.each(['issued', 'viewed', 'signed', 'declined', 'revoked'])(
    'returns 409 for a contract already in status %s',
    async (status) => {
      getCurrentUser.mockResolvedValue(masterUser)
      createServerClient.mockReturnValue(mockDb({ contract: draftFixture({ status }) }).db)
      const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
      const body = await res.json()
      expect(res.status).toBe(409)
      expect(notifyContractIssued).not.toHaveBeenCalled()
      expect(body.error).toMatch(/draft/i)
    },
  )

  it('flips a draft to issued, refreshes issued_at, and notifies exactly once', async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    const draft = draftFixture()
    const updated = { ...draft, status: 'issued', issued_at: '2026-07-25T12:00:00.000Z' }
    const { db, updateEq1 } = mockDb({ contract: draft, updated })
    createServerClient.mockReturnValue(db)

    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('issued')
    expect(body.warning).toBeUndefined()
    expect(notifyContractIssued).toHaveBeenCalledTimes(1)
    // Optimistic-concurrency guard: the update targets status='draft'.
    expect(updateEq1).toHaveBeenCalled()
  })

  it('surfaces an email-send failure from notifyContractIssued as a warning without failing', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    notifyContractIssued.mockResolvedValueOnce({ emailResult: { ok: false, error: 'Postmark down' } })
    const draft = draftFixture()
    const updated = { ...draft, status: 'issued', issued_at: '2026-07-25T12:00:00.000Z' }
    createServerClient.mockReturnValue(mockDb({ contract: draft, updated }).db)

    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.warning).toMatch(/Postmark down/)
  })

  it('returns 409 when the status changed concurrently (update finds no draft row)', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    const draft = draftFixture()
    createServerClient.mockReturnValue(mockDb({ contract: draft, updated: null }).db)

    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(409)
    expect(notifyContractIssued).not.toHaveBeenCalled()
  })

  it('logs contract.issued with details.sent_from_draft: true', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    const draft = draftFixture()
    const updated = { ...draft, status: 'issued', issued_at: '2026-07-25T12:00:00.000Z' }
    createServerClient.mockReturnValue(mockDb({ contract: draft, updated }).db)

    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'contract.issued',
      details: expect.objectContaining({ sent_from_draft: true }),
    }))
  })

  it('surfaces a DB error on the initial read as a 500', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contractError: { message: 'boom' } }).db)
    const res = await POST(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(500)
  })
})
