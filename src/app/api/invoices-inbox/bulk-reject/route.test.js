// POST /api/invoices-inbox/bulk-reject through the real withAuth wrapper:
// signed in (401), the bookkeeper flag (403, loadBookkeeper's old text), the
// body (400), then per-row scoping (another studio's row is skipped as
// forbidden and left alone). A failed lookup answers a fixed 500.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const ROW_A = 'e1000000-0000-4000-8000-000000000001'
const ROW_B = 'e1000000-0000-4000-8000-000000000002'
const BOOKKEEPER_OWNER_A = person({ [LOC_A]: { role: 'owner', permissions: { bookkeeper: true } } }, LOC_A)
const OWNER_A_NO_FLAG = person({ [LOC_A]: { role: 'owner', permissions: { bookkeeper: false } } }, LOC_A)
const reject = (body = { ids: [ROW_A, ROW_B], reason: 'Duplicate' }) => POST(new Request('http://localhost/api/invoices-inbox/bulk-reject', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { invoices_queue: [
    { id: ROW_A, location_id: LOC_A, status: 'received', source_type: 'email' },
    { id: ROW_B, location_id: LOC_B, status: 'received', source_type: 'email' },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/invoices-inbox/bulk-reject', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await reject()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.invoices_queue.every((r) => r.status === 'received')).toBe(true)
  })

  it('403 without the bookkeeper flag, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_NO_FLAG)
    const res = await reject({})
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Bookkeeper permission required — ask a master to grant the bookkeeper flag.' })
  })

  it('400 on a bad body', async () => {
    getCurrentUser.mockResolvedValue(BOOKKEEPER_OWNER_A)
    expect((await reject({ ids: [ROW_A] })).status).toBe(400)
  })

  it('rejects the caller’s own studio row and skips another studio’s as forbidden', async () => {
    getCurrentUser.mockResolvedValue(BOOKKEEPER_OWNER_A)
    const res = await reject()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.results).toEqual(expect.arrayContaining([
      { id: ROW_B, outcome: 'skipped', reason: 'forbidden' },
      { id: ROW_A, outcome: 'ok', stage: 'quality' },
    ]))
    expect(db.tables.invoices_queue.find((r) => r.id === ROW_A).status).toBe('rejected')
    expect(db.tables.invoices_queue.find((r) => r.id === ROW_B).status).toBe('received')
  })

  it('a failed lookup answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(BOOKKEEPER_OWNER_A)
    db.errors.invoices_queue = { select: { message: 'permission denied for table invoices_queue' } }
    const res = await reject()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the invoices. Try again.' })
  })

  it('a failed row write is reported per row with a fixed message', async () => {
    getCurrentUser.mockResolvedValue(BOOKKEEPER_OWNER_A)
    db.errors.invoices_queue = { update: { message: 'deadlock detected' } }
    const { data } = await (await reject()).json()
    expect(data.results).toContainEqual({ id: ROW_A, outcome: 'failed', error: 'Could not reject this invoice.' })
  })
})
