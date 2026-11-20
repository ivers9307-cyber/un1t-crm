// RCOV.P1 — DELETE /api/accounting/mailboxes/[id] through the real withAuth
// wrapper: accounting_hub at the active studio, the delete scoped to it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { DELETE } = await import('./route.js')

const MINE = 'b1000000-0000-4000-8000-000000000001'
const THEIRS = 'b1000000-0000-4000-8000-000000000002'
let db
const del = (id = MINE) => DELETE(new Request(`http://localhost/api/accounting/mailboxes/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) })
const hub = (on) => person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { recon_mailboxes: [
    { id: MINE, label: 'Hunt', email: 'hunt@example.com', location_id: LOC_A },
    { id: THEIRS, label: 'Hunt', email: 'hunt2@example.com', location_id: LOC_B },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('DELETE /api/accounting/mailboxes/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await del()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without accounting_hub, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue(hub(false))
    const res = await del()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(db.tables.recon_mailboxes).toHaveLength(2)
  })

  it('deletes the active studio’s inbox', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    const res = await del()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.tables.recon_mailboxes.map((m) => m.id)).toEqual([THEIRS])
  })

  it('404 for another studio’s inbox, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    expect((await del(THEIRS)).status).toBe(404)
    expect(db.tables.recon_mailboxes).toHaveLength(2)
  })

  it('a failed delete is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    createServerClient.mockReturnValue(createFakeDb({ tables: { recon_mailboxes: [] }, errors: { recon_mailboxes: { delete: { message: 'secret detail' } } } }))
    const res = await del()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
