// GET /api/contacts/[id]/impact through the real withAuth wrapper: manager+
// somewhere (or an organisation admin) first, then the delete decision at the
// contact's primary studio (the full sweep is
// tests/role-sweep/contacts-bulk-and-imports.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, ORG } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contact-merge', () => ({ getContactImpact: vi.fn(async () => ({ cascade: { notes: 2 }, preserve: {} })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { getContactImpact } = await import('@/lib/contact-merge')
const { GET } = await import('./route.js')

const AT_A = 'c0000000-0000-4000-8000-0000000000a1'
const AT_B = 'c0000000-0000-4000-8000-0000000000b1'
const get = (id = AT_A) => GET(new Request(`http://localhost/api/contacts/${id}/impact`), { params: Promise.resolve({ id }) })
const MANAGER_REQUIRED = { success: false, error: 'Manager+ required' }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { contacts: [
    { id: AT_A, location_id: LOC_A, organization_id: ORG },
    { id: AT_B, location_id: LOC_B, organization_id: ORG },
  ] } }))
})

describe('GET /api/contacts/[id]/impact', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Manager+ required" for a caller who is a manager nowhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(MANAGER_REQUIRED)
    expect(getContactImpact).not.toHaveBeenCalled()
  })

  it('403 "Manager+ required" for a manager elsewhere than the contact’s primary studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff' } }, LOC_A))
    const res = await get(AT_B)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(MANAGER_REQUIRED)
  })

  it('a manager at the primary studio gets the impact', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { cascade: { notes: 2 }, preserve: {} } })
  })

  it('404 for an unknown contact', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    expect((await get('c0000000-0000-4000-8000-0000000000ff')).status).toBe(404)
  })
})
