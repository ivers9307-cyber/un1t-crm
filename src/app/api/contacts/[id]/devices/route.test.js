// Tests for /api/contacts/[id]/devices — focus on the location IDOR gate
// (2026-06 audit). The GET handler previously listed any contact's devices
// (chest-strap MACs) for any authenticated user; the POST guard read a
// non-existent `user.locationIds` field so it failed closed for every
// non-master. Both now derive ids from `user.locations` via
// getUserLocationIds and gate on the contact's studio.
//
// Person-group: when a contact belongs to a person group, GET returns
// devices from all linked contacts (annotated with owner_name for non-self).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// SECFIX.1 — the REAL per-location role helpers (pure: role-at-location).
vi.mock('@/lib/auth', async () => ({
  ...(await vi.importActual('@/lib/role-at-location')),
  getCurrentUser: vi.fn(),
  getUserLocationIds: (u) => (u?.locations || []).map((l) => l.id),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contact-devices', () => ({
  listForContacts: vi.fn(),
  validateDeviceInput: vi.fn(() => ({
    ok: true,
    normalised: { device_type: 'hr_strap', identifier: 'AA:BB:CC:DD:EE:FF', label: null, manufacturer: null },
  })),
}))
vi.mock('@/lib/person-links', () => ({ getPersonGroup: vi.fn(() => Promise.resolve(null)) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listForContacts } from '@/lib/contact-devices'
import { getPersonGroup } from '@/lib/person-links'

// db mock dispatching by table.
// 'contacts' → select→eq→single (IDOR gate) OR select→in (owner names lookup)
// 'contact_devices' → insert→select→single (POST happy path)
function mockDb({ contact, contactError, insertResult, insertError, ownerRows } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        // Support both .eq().single() (IDOR gate) and .in() (owner names)
        const single = vi.fn(() =>
          Promise.resolve(contactError ? { data: null, error: contactError } : { data: contact, error: null })
        )
        const eqChain = { single }
        const inFn = vi.fn(() => Promise.resolve({ data: ownerRows || [], error: null }))
        const selectFn = vi.fn(() => ({ eq: vi.fn(() => eqChain), in: inFn }))
        return { select: selectFn }
      }
      if (table === 'contact_devices') {
        const single = vi.fn(() =>
          Promise.resolve(insertError ? { data: null, error: insertError } : { data: insertResult, error: null })
        )
        return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single })) })) }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

beforeEach(() => { vi.clearAllMocks() })

const getReq = () => new Request('http://localhost/api/contacts/c1/devices', { method: 'GET' })
const postReq = (body = { device_type: 'hr_strap', identifier: 'AA:BB:CC:DD:EE:FF' }) =>
  new Request('http://localhost/api/contacts/c1/devices', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })

describe('GET /api/contacts/[id]/devices — IDOR gate', () => {
  it('401 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(getReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('404 when contact not found (no device read)', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: true })
    createServerClient.mockReturnValue(mockDb({ contactError: { message: 'nope' } }))
    const res = await GET(getReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(404)
    expect(listForContacts).not.toHaveBeenCalled()
  })

  it('403 when the contact is in another studio — cross-tenant read blocked', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'manager', locations: [{ id: 'loc-OTHER' }], rolesByLocation: { 'loc-OTHER': 'manager' } })
    createServerClient.mockReturnValue(mockDb({ contact: { id: 'c1', location_id: 'loc-1' } }))
    const res = await GET(getReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(403)
    expect(listForContacts).not.toHaveBeenCalled()
  })

  it('200 + devices when the caller is at the contact location (any role reads)', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'staff', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({ contact: { id: 'c1', location_id: 'loc-1' } }))
    listForContacts.mockResolvedValue({ devices: [{ id: 'd1', contact_id: 'c1' }], error: null })
    const res = await GET(getReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.devices[0].id).toBe('d1')
    // Single contact — owner_name is null for self
    expect(json.devices[0].owner_name).toBe(null)
  })

  it('200 for master regardless of the contact location', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: true })
    createServerClient.mockReturnValue(mockDb({ contact: { id: 'c1', location_id: 'loc-WHATEVER' } }))
    listForContacts.mockResolvedValue({ devices: [], error: null })
    const res = await GET(getReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/contacts/[id]/devices — person group aggregation', () => {
  it('returns devices from all linked contacts when in a person group', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
    createServerClient.mockReturnValue(mockDb({
      contact: { id: 'c1', location_id: 'loc-1' },
      ownerRows: [
        { id: 'c1', name: 'Alice' },
        { id: 'c2', name: 'Alice (ClassPass)' },
      ],
    }))
    // getPersonGroup returns a group with two members
    getPersonGroup.mockResolvedValue({
      group: { id: 'g1', primary_contact_id: 'c1' },
      members: [{ contact_id: 'c1' }, { contact_id: 'c2' }],
    })
    // Both contacts have a device
    listForContacts.mockResolvedValue({
      devices: [
        { id: 'd1', contact_id: 'c1', device_type: 'chest_strap' },
        { id: 'd2', contact_id: 'c2', device_type: 'chest_strap' },
      ],
      error: null,
    })

    const res = await GET(getReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.devices).toHaveLength(2)
    // c1's device: owner_name is null (it IS the requested contact)
    const d1 = json.devices.find((d) => d.id === 'd1')
    expect(d1.owner_name).toBe(null)
    // c2's device: owner_name should be set
    const d2 = json.devices.find((d) => d.id === 'd2')
    expect(d2.owner_name).toBe('Alice (ClassPass)')
  })
})

describe('POST /api/contacts/[id]/devices — location guard (repaired)', () => {
  it('403 when a manager is at a different location', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'manager', locations: [{ id: 'loc-OTHER' }], rolesByLocation: { 'loc-OTHER': 'manager' } })
    createServerClient.mockReturnValue(mockDb({ contact: { id: 'c1', location_id: 'loc-1' } }))
    const res = await POST(postReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(403)
  })

  it('201 when a manager is at the contact location — guard now actually passes', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
    createServerClient.mockReturnValue(mockDb({
      contact: { id: 'c1', location_id: 'loc-1' },
      insertResult: { id: 'd1', device_type: 'hr_strap', identifier: 'AA:BB:CC:DD:EE:FF', label: null, manufacturer: null, is_active: true, added_by_contact: false, created_at: '2026-06-08T00:00:00Z' },
    }))
    const res = await POST(postReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.device.id).toBe('d1')
  })
})

// SECFIX.1 — the write role is judged AT THE CONTACT's location, never at the
// caller's ACTIVE studio (`user.role`). Synthetic ids only.
describe('POST /api/contacts/[id]/devices — role judged at the contact\'s location', () => {
  const INSERTED = { id: 'd1', device_type: 'hr_strap', identifier: 'AA:BB:CC:DD:EE:FF', label: null, manufacturer: null, is_active: true, added_by_contact: false, created_at: '2026-06-08T00:00:00Z' }

  it('403 Admin only for staff at the contact\'s location whose ACTIVE studio makes them a manager', async () => {
    getCurrentUser.mockResolvedValue({
      isMaster: false, profileRole: 'staff', role: 'manager',
      locations: [{ id: 'loc-1' }, { id: 'loc-OTHER' }],
      rolesByLocation: { 'loc-1': 'staff', 'loc-OTHER': 'manager' },
    })
    const db = mockDb({ contact: { id: 'c1', location_id: 'loc-1' }, insertResult: INSERTED })
    createServerClient.mockReturnValue(db)
    const res = await POST(postReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Admin only' })
    expect(db.from).not.toHaveBeenCalledWith('contact_devices')
  })

  it('201 for a manager at the contact\'s location while a studio where they are staff is active', async () => {
    getCurrentUser.mockResolvedValue({
      isMaster: false, profileRole: 'staff', role: 'staff',
      locations: [{ id: 'loc-1' }, { id: 'loc-OTHER' }],
      rolesByLocation: { 'loc-1': 'manager', 'loc-OTHER': 'staff' },
    })
    createServerClient.mockReturnValue(mockDb({ contact: { id: 'c1', location_id: 'loc-1' }, insertResult: INSERTED }))
    const res = await POST(postReq(), { params: { id: 'c1' } })
    expect(res.status).toBe(201)
  })
})
