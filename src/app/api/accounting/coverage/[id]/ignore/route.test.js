// RCOV.P2 — POST /api/accounting/coverage/[id]/ignore through the real withAuth
// wrapper: accounting_hub at the active studio, line scoped to it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const L1 = 'e1000000-0000-4000-8000-000000000001'
const L_OTHER = 'e1000000-0000-4000-8000-000000000002'
const post = (id = L1, body = { reason: 'bank fee' }) => POST(
  new Request(`http://localhost/api/accounting/coverage/${id}/ignore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
)
const rows = () => [
  { id: L1, location_id: LOC_A, status: 'uncovered', hunt_queued_at: '2026-11-19T10:00:00Z' },
  { id: L_OTHER, location_id: LOC_B, status: 'uncovered' },
]
const owner = () => person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: true } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { recon_bank_lines: rows() } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/accounting/coverage/[id]/ignore', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })

  it('403 "Forbidden" without accounting_hub, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { accounting_hub: false } } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(db.tables.recon_bank_lines[0].status).toBe('uncovered')
  })

  it('404 for a line at another studio', async () => {
    getCurrentUser.mockResolvedValue(owner())
    expect((await post(L_OTHER)).status).toBe(404)
    expect(db.tables.recon_bank_lines[1].status).toBe('uncovered')
  })

  it('an owner ignores the line and clears the hunt flags', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.tables.recon_bank_lines[0]).toMatchObject({ status: 'ignored', ignore_reason: 'bank fee', ignored_by: 'user-1', hunt_queued_at: null, hunt_claimed_at: null })
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(createFakeDb({ tables: { recon_bank_lines: rows() }, errors: { recon_bank_lines: { update: { message: 'secret detail' } } } }))
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
