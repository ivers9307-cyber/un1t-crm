// SECFIX.1 — DELETE / PATCH /api/contacts/[id]/devices/[deviceId].
//
// The defect: neither handler read the contact or checked the caller belongs
// to its location. The only gate was `WRITE_ROLES.includes(user.role)` — the
// role at the caller's ACTIVE studio — so any owner, manager or head coach
// anywhere could delete or relabel a heart-rate strap on any contact in the
// estate by id (a cross-tenant IDOR).
//
// Now: the contact is read, and a missing contact and a contact at a studio
// the caller is not in answer the SAME 404 `{ ok:false, error:'Contact not
// found' }` (the shape ContactDevicesCard reads), and
// the write role is judged AT THE CONTACT'S location (hasRoleAtLocation),
// never at the active studio. Masters are exempt, as on the sibling
// GET / POST in ../route.js.
//
// `@/lib/auth` is only PARTIALLY mocked: getCurrentUser is a stub, the
// guards are the REAL functions. All ids and names are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/person-links', () => ({ getPersonGroup: vi.fn(() => Promise.resolve(null)) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

import { DELETE, PATCH } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
const LOC_B = 'b0000000-0000-4000-8000-00000000000b'
const CONTACT_ID = 'c0000000-0000-4000-8000-000000000001'
const DEVICE_ID = 'd0000000-0000-4000-8000-000000000001'

// A non-master caller: `roles` is { [locationId]: role }, `active` the active studio.
const person = (roles, active) => ({
  id: 'u0000000-0000-4000-8000-000000000001',
  isMaster: false,
  profileRole: 'staff',
  role: roles[active],
  activeLocation: { id: active },
  locations: Object.keys(roles).map((id) => ({ id })),
  rolesByLocation: { ...roles },
})
const MASTER = {
  id: 'u0000000-0000-4000-8000-00000000000m',
  isMaster: true,
  profileRole: 'master',
  role: 'master',
  locations: [],
  rolesByLocation: {},
}

const DEVICE_ROW = {
  id: DEVICE_ID, device_type: 'chest_strap', identifier: 'AA:BB:CC:DD:EE:FF', label: 'Left strap',
  manufacturer: null, is_active: true, added_by_contact: false, created_at: '2026-01-01T00:00:00Z',
}

// Records every write so a test can assert nothing was deleted / updated.
function mockDb({ contact = { id: CONTACT_ID, location_id: LOC_A }, contactError = null } = {}) {
  const writes = []
  const db = {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(
                contactError || !contact ? { data: null, error: contactError || { message: 'no rows' } } : { data: contact, error: null },
              )),
            })),
          })),
        }
      }
      if (table === 'contact_devices') {
        return {
          delete: vi.fn(() => {
            writes.push('delete')
            return { eq: vi.fn(() => ({ in: vi.fn(() => Promise.resolve({ error: null })) })) }
          }),
          update: vi.fn(() => {
            writes.push('update')
            return {
              eq: vi.fn(() => ({
                in: vi.fn(() => ({
                  select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: DEVICE_ROW, error: null })) })),
                })),
              })),
            }
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, writes }
}

const params = () => ({ params: Promise.resolve({ id: CONTACT_ID, deviceId: DEVICE_ID }) })
const delReq = () => new Request('http://localhost/api/contacts/x/devices/y', { method: 'DELETE' })
const patchReq = (body = { label: 'Right strap' }) => new Request('http://localhost/api/contacts/x/devices/y', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => vi.clearAllMocks())

const HANDLERS = [
  ['DELETE', () => DELETE(delReq(), params()), 'delete'],
  ['PATCH', () => PATCH(patchReq(), params()), 'update'],
]

describe.each(HANDLERS)('%s /api/contacts/[id]/devices/[deviceId]', (_name, call, write) => {
  it('401 with no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
  })

  it('a manager who does NOT belong to the contact\'s location gets the detail 404 and writes nothing (the IDOR)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'manager' }, LOC_B))
    const { db, writes } = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'Contact not found' })
    expect(writes).toEqual([])
  })

  it('an owner who does NOT belong to the contact\'s location gets the detail 404 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'owner' }, LOC_B))
    const { db, writes } = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'Contact not found' })
    expect(writes).toEqual([])
  })

  it('a contact at another studio and a missing contact answer the SAME 404 (no existence leak)', async () => {
    const caller = person({ [LOC_B]: 'manager' }, LOC_B)
    getCurrentUser.mockResolvedValue(caller)
    createServerClient.mockReturnValue(mockDb().db)
    const elsewhere = await call()
    createServerClient.mockReturnValue(mockDb({ contact: null }).db)
    const missing = await call()
    expect(missing.status).toBe(404)
    expect(elsewhere.status).toBe(404)
    expect(await elsewhere.json()).toEqual(await missing.json())
  })

  it('a missing contact answers the route\'s own 404 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'manager' }, LOC_A))
    const { db, writes } = mockDb({ contact: null })
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'Contact not found' })
    expect(writes).toEqual([])
  })

  it('staff at the contact\'s location, manager at the ACTIVE studio: 403 Admin only (role judged at the contact)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'staff', [LOC_B]: 'manager' }, LOC_B))
    const { db, writes } = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Admin only' })
    expect(writes).toEqual([])
  })

  it('manager at the contact\'s location while a studio where they are staff is active: allowed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_B))
    const { db, writes } = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(200)
    expect(writes).toEqual([write])
  })

  it.each(['owner', 'manager', 'head_coach'])('%s at the contact\'s location: allowed', async (role) => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: role }, LOC_A))
    const { db, writes } = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(writes).toEqual([write])
  })

  it('plain staff everywhere: 403 Admin only before any read', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'staff' }, LOC_A))
    const { db, writes } = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Admin only' })
    expect(db.from).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('a master is allowed at any location', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, writes } = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(200)
    expect(writes).toEqual([write])
  })
})
