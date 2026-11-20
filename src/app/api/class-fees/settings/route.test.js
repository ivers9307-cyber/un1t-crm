// FEES.1 — PUT /api/class-fees/settings through the real withAuth wrapper. The
// hand-written checks run in their old order: body 400, studio membership 403,
// master or owner at the body's studio 403; only then is the settings merged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A, LOC_B, LOC_OTHER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PUT } = await import('./route.js')

const body = (loc = LOC_B) => ({
  location_id: loc, enabled: true, charging_paused: false,
  late_cancel_fee_cents: 500, no_show_fee_cents: 1000, review_emails: ['Desk@Example.com'],
})
const put = (b) => PUT(new Request('http://localhost/api/class-fees/settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}))
const ownerAtB = () => person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'owner' } }, LOC_A)
const managerAtB = () => person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'manager' } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { locations: [{ id: LOC_B, settings: { glofox: { branch_id: 'x' } } }] } })
  createServerClient.mockReturnValue(db)
})

const stored = () => db.tables.locations[0].settings

describe('PUT /api/class-fees/settings', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await put(body())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(stored().un1t_online).toBeUndefined()
  })

  it('400 on a bad body before any studio check', async () => {
    getCurrentUser.mockResolvedValue(ownerAtB())
    expect((await put({ location_id: LOC_B })).status).toBe(400)
  })

  it('403 for a studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(ownerAtB())
    const res = await put(body(LOC_OTHER))
    expect(res.status).toBe(403)
    expect(stored().un1t_online).toBeUndefined()
  })

  it('403 for a manager at the body\'s studio, though owner at the active one', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    const res = await put(body())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master or owner role required.' })
    expect(stored().un1t_online).toBeUndefined()
  })

  it('an owner at the body\'s studio saves the fees, keeping sibling settings', async () => {
    getCurrentUser.mockResolvedValue(ownerAtB())
    const res = await put(body())
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(stored().glofox).toEqual({ branch_id: 'x' })
    expect(stored().un1t_online.fees).toMatchObject({ enabled: true, late_cancel_fee_cents: 500, no_show_fee_cents: 1000, review_emails: ['desk@example.com'] })
  })

  it('a master may save', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await put(body())).status).toBe(200)
  })
})
