// EQUIP-MAINT.1 — route tests for a single asset.
//
// The 404-not-403 test is the IDOR guard: these routes run on the
// service-role client, which bypasses RLS entirely, so the location
// check in app code is the ONLY thing protecting the row.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) => {
    let input
    if (opts?.schema) {
      const parsed = opts.schema.safeParse(await request.json())
      if (!parsed.success) {
        return { status: 400, json: async () => ({ success: false, error: 'Invalid body.' }) }
      }
      input = parsed.data
    }
    return handler({
      user: h.user,
      db: {},
      locationId: h.locationId,
      request,
      input,
      params: ctx?.params ? await ctx.params : undefined,
    })
  },
}))
vi.mock('@/lib/equipment-db', () => ({
  getEquipment: vi.fn(),
  updateEquipment: vi.fn(),
  getType: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { GET, PATCH, DELETE } from './route.js'
import { getEquipment, updateEquipment, getType } from '@/lib/equipment-db'

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}
const ctx = { params: { id: 'eq-1' } }

const ASSET = {
  id: 'eq-1',
  location_id: 'loc-1',
  name: 'Treadmill 3',
  status: 'in_service',
  out_of_service_issue_id: null,
  next_due_on: '2026-08-04',
}

beforeEach(() => {
  vi.clearAllMocks()
  getEquipment.mockResolvedValue(ASSET)
  updateEquipment.mockImplementation(async (_db, _id, patch) => ({ ...ASSET, ...patch }))
  getType.mockResolvedValue({ id: 'type-2', location_id: 'loc-1', name: 'Rower', enabled: true })
})

describe('GET /api/equipment/[id]', () => {
  it('returns 404 (NOT 403) for an asset at another location', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, location_id: 'loc-OTHER' })
    const res = await GET(req(null), ctx)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found.')
  })

  it('returns 404 for an id that does not exist', async () => {
    getEquipment.mockResolvedValue(null)
    const res = await GET(req(null), ctx)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/equipment/[id]', () => {
  it('refuses to edit a retired asset', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, status: 'retired' })
    const res = await PATCH(req({ name: 'Treadmill 4' }), ctx)
    expect(res.status).toBe(409)
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  it('rejects an empty patch with 400', async () => {
    const res = await PATCH(req({}), ctx)
    expect(res.status).toBe(400)
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  it('clears the linked issue when returned to service by hand', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, status: 'out_of_service', out_of_service_issue_id: 'iss-1' })
    await PATCH(req({ status: 'in_service' }), ctx)
    expect(updateEquipment).toHaveBeenCalledWith({}, 'eq-1', expect.objectContaining({
      status: 'in_service',
      out_of_service_issue_id: null,
    }))
  })

  it('leaves next_due_on alone when the type changes', async () => {
    // Must actually exercise the re-type path (a same-location typeId
    // different from the asset's current type_id) — the previous
    // version of this test sent only { name }, so it never touched the
    // typeId branch at all and would have passed even if re-typing DID
    // reset next_due_on.
    await PATCH(req({ typeId: 'type-2' }), ctx)
    expect(getType).toHaveBeenCalledWith({}, 'type-2')
    const patch = updateEquipment.mock.calls.at(-1)[2]
    expect(patch).toHaveProperty('type_id', 'type-2')
    expect(patch).not.toHaveProperty('next_due_on')
  })
})

describe('DELETE /api/equipment/[id]', () => {
  it('retires rather than deleting, so the compliance log survives', async () => {
    await DELETE(req(null), ctx)
    expect(updateEquipment).toHaveBeenCalledWith({}, 'eq-1', expect.objectContaining({ status: 'retired' }))
  })

  it('returns 404 for an asset at another location', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, location_id: 'loc-OTHER' })
    const res = await DELETE(req(null), ctx)
    expect(res.status).toBe(404)
    expect(updateEquipment).not.toHaveBeenCalled()
  })
})
