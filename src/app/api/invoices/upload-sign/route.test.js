// POST /api/invoices/upload-sign through the real withAuth wrapper: signed in
// (401), a contractor account (403, the old text), the body (400), then a
// signed-upload token for the caller's own folder. A storage failure answers
// a fixed 500, never the storage text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')

const CONTRACTOR = person({ [LOC_A]: { role: 'staff' } }, LOC_A, { employment_type: 'contractor' })
const EMPLOYEE = person({ [LOC_A]: { role: 'staff' } }, LOC_A, { employment_type: 'employee' })
const BODY = { month: '2026-10', size: 1000, mime: 'application/pdf', file_name: 'october.pdf' }
const sign = (body = BODY) => POST(new Request('http://localhost/api/invoices/upload-sign', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db, signed

beforeEach(() => {
  vi.clearAllMocks()
  signed = { data: { token: 'tok-1' }, error: null }
  db = createFakeDb()
  db.storage = { from: vi.fn(() => ({ createSignedUploadUrl: vi.fn(async () => signed) })) }
  createServerClient.mockReturnValue(db)
})

describe('POST /api/invoices/upload-sign', () => {
  it('401 signed out, no upload slot minted', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await sign()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.storage.from).not.toHaveBeenCalled()
  })

  it('403 for an account that is not a contractor, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(EMPLOYEE)
    const res = await sign({})
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Only contractor accounts can submit invoices.' })
    expect(db.storage.from).not.toHaveBeenCalled()
  })

  it('400 on a bad body', async () => {
    getCurrentUser.mockResolvedValue(CONTRACTOR)
    expect((await sign({ ...BODY, month: 'October' })).status).toBe(400)
    expect((await sign({ ...BODY, mime: 'text/html' })).status).toBe(400)
  })

  it('mints a token for a path in the contractor’s own folder', async () => {
    getCurrentUser.mockResolvedValue(CONTRACTOR)
    const res = await sign()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.token).toBe('tok-1')
    expect(body.path).toContain(CONTRACTOR.id)
    expect(db.storage.from).toHaveBeenCalledWith('contractor-invoices')
  })

  it('a storage failure answers a fixed 500 and logs the cause', async () => {
    getCurrentUser.mockResolvedValue(CONTRACTOR)
    signed = { data: null, error: { message: 'bucket contractor-invoices: JWT expired' } }
    const res = await sign()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not create the upload link. Try again.' })
    expect(logError).toHaveBeenCalled()
  })
})
