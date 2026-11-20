// INVOICES.2 — GET /api/invoices-inbox/unread-count through the real withAuth
// wrapper: the active studio's pending rows, a quiet zero without the grant.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

let db
const get = () => GET(new Request('http://localhost/api/invoices-inbox/unread-count'))
const caller = (on) => person({ [LOC_A]: { role: 'owner', permissions: { invoices_inbox: on } }, [LOC_B]: { role: 'owner', permissions: { invoices_inbox: true } } }, LOC_A)
const row = (n, location_id, status) => ({ id: `e0000000-0000-4000-8000-00000000000${n}`, location_id, status })

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { invoices_queue: [row(1, LOC_A, 'received'), row(2, LOC_A, 'extracted'), row(3, LOC_A, 'forwarded'), row(4, LOC_B, 'received')] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/invoices-inbox/unread-count', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('a quiet zero without invoices_inbox at the active studio', async () => {
    getCurrentUser.mockResolvedValue(caller(false))
    expect(await (await get()).json()).toEqual({ success: true, data: { count: 0 } })
    expect(db.calls).toEqual([])
  })

  it('counts the active studio’s pending rows only', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    expect(await (await get()).json()).toEqual({ success: true, data: { count: 2 } })
  })

  it('a failed count is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    db.errors.invoices_queue = { select: { message: 'secret detail' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
