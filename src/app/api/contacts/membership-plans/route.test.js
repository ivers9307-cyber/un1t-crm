// CHURN-PREP.2 — GET /api/contacts/membership-plans through the real withAuth
// wrapper: manager+ at the active studio; plans from that studio only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const c = (n, loc, plan) => ({ id: `c${n}000000-0000-4000-8000-000000000000`, location_id: loc, glofox_membership_plan: plan })
const contacts = () => [
  c(1, LOC_A, '3 Month Membership'), c(2, LOC_A, '10 Class Pack'), c(3, LOC_A, '10 Class Pack'), c(4, LOC_A, null),
  c(5, LOC_B, 'Other Studio Plan'),
]
const get = () => GET(new Request('http://localhost/api/contacts/membership-plans'))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { contacts: contacts() } }))
})

describe('GET /api/contacts/membership-plans', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Manager+ required" for staff at the active studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
  })

  it('a manager gets the active studio\'s distinct plans, never another studio\'s', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(['10 Class Pack', '3 Month Membership'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    createServerClient.mockReturnValue(createFakeDb({ tables: { contacts: contacts() }, errors: { contacts: { select: { message: 'secret detail' } } } }))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
