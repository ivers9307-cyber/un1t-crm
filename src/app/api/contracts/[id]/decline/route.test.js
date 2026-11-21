// POST /api/contracts/[id]/decline through the real withAuth wrapper, which only
// signs the caller in. The body, the contract (404), the recipient (403) and the
// state (409) keep their order; the write, audit row and issuer email are
// unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/contracts-email', async (importOriginal) => ({ ...(await importOriginal()), sendContractDeclinedEmail: vi.fn(async () => ({ ok: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { sendContractDeclinedEmail } = await import('@/lib/contracts-email')
const { POST } = await import('./route.js')

const CONTRACT = 'c0a70000-0000-4000-8000-000000000001'
const RECIPIENT = person({ [LOC_A]: { role: 'staff' } }, LOC_A, { id: 'ee000000-0000-4000-8000-000000000001' })
const SOMEONE_ELSE = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { id: 'ee000000-0000-4000-8000-000000000002' })
const decline = (id = CONTRACT) => POST(new Request(`http://localhost/api/contracts/${id}/decline`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ declined_reason: 'Wrong hours' }),
}), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    profiles: [{ id: RECIPIENT.id, full_name: 'Coach One', email: 'coach.one@example.com' }],
    contracts: [{ id: CONTRACT, profile_id: RECIPIENT.id, status: 'issued' }],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/contracts/[id]/decline', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await decline()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.contracts[0].status).toBe('issued')
  })

  it('404 for an unknown contract', async () => {
    getCurrentUser.mockResolvedValue(RECIPIENT)
    expect((await decline('c0a70000-0000-4000-8000-000000000009')).status).toBe(404)
  })

  it('403 for anyone but the recipient, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(SOMEONE_ELSE)
    expect((await decline()).status).toBe(403)
    expect(db.tables.contracts[0].status).toBe('issued')
    expect(sendContractDeclinedEmail).not.toHaveBeenCalled()
  })

  it('the recipient declines it and the issuer is emailed once', async () => {
    getCurrentUser.mockResolvedValue(RECIPIENT)
    const res = await decline()
    expect(res.status).toBe(200)
    expect(db.tables.contracts[0]).toMatchObject({ status: 'declined', declined_reason: 'Wrong hours' })
    expect(sendContractDeclinedEmail).toHaveBeenCalledTimes(1)
  })

  it('a failed issuer email is a fixed warning, never the provider text', async () => {
    getCurrentUser.mockResolvedValue(RECIPIENT)
    sendContractDeclinedEmail.mockResolvedValueOnce({ ok: false, error: 'Postmark 422: issuer@example.com is inactive' })
    const body = await (await decline()).json()
    expect(body.success).toBe(true)
    expect(body.warning).toBe('Decline recorded but the issuer email failed.')
  })

  it('a failed read answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(RECIPIENT)
    db.errors.contracts = { select: { message: 'permission denied for table contracts' } }
    const res = await decline()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the contract. Try again.' })
  })
})
