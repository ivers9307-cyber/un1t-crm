// POST /api/admin/tenants/wallet-adjust through the real withAuth wrapper:
// signed in, then by hand, in the old order: profiles.role master 403, body
// 400, location 404; the wallet write is unchanged. Wider cases live in
// ../route.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/wallet', async (importOriginal) => ({ ...(await importOriginal()), applyWalletEntry: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { applyWalletEntry } = await import('@/lib/wallet')
const { POST } = await import('./route.js')

const post = (body) => POST(new Request('http://localhost/api/admin/tenants/wallet-adjust', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const OK = { locationId: LOC_B, amountCents: 500, note: 'Goodwill credit' }
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { locations: [{ id: LOC_B, name: 'Studio B' }] } })
  createServerClient.mockReturnValue(db)
  applyWalletEntry.mockResolvedValue(1500)
})

describe('POST /api/admin/tenants/wallet-adjust', () => {
  it('401 signed out, no wallet write', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(OK)).status).toBe(401)
    expect(applyWalletEntry).not.toHaveBeenCalled()
  })

  it('403 "Master only" for an owner, before the body is read', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner' } }, LOC_B))
    const res = await post({})
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
  })

  it('404 for an unknown location', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post({ ...OK, locationId: 'd0000000-0000-4000-8000-0000000000aa' })).status).toBe(404)
    expect(applyWalletEntry).not.toHaveBeenCalled()
  })

  it('a master posts the adjustment, signed by them', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post(OK)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { locationId: LOC_B, balanceCents: 1500 } })
    expect(applyWalletEntry.mock.calls[0][1]).toEqual({ locationId: LOC_B, kind: 'adjustment', amountCents: 500, note: 'Goodwill credit', createdBy: MASTER.id })
  })

  it('a refusal is still a 400, with the floor named and no database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    applyWalletEntry.mockRejectedValue(new Error(`applyWalletEntry: wallet_apply: grace floor breached for location ${LOC_B} (kind=adjustment, meter=-): 0 + -5000 = -5000 < -1000`))
    let res = await post({ ...OK, amountCents: -5000 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'That debit would take the wallet below its grace floor.' })
    applyWalletEntry.mockRejectedValue(new Error('applyWalletEntry: connection reset by peer'))
    res = await post(OK)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'The adjustment could not be applied.' })
  })
})
