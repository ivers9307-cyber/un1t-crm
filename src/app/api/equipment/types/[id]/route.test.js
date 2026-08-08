// EQUIP-MAINT.1f — route tests for a single equipment type.
//
// The 404-not-403 test is the IDOR guard: these routes run on the
// service-role client, which bypasses RLS entirely, so the location
// check in app code is the ONLY thing protecting the row. Flagged at
// final review as one of the two subtlest cross-location guards left
// untested in PR 1.

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
  getType: vi.fn(),
  updateType: vi.fn(),
  countActiveAssetsOfType: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { PATCH, DELETE } from './route.js'
import { getType, updateType, countActiveAssetsOfType } from '@/lib/equipment-db'

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}
const ctx = { params: { id: 'type-1' } }

const TYPE = {
  id: 'type-1',
  location_id: 'loc-1',
  name: 'Treadmill',
  enabled: true,
  interval_weeks: 4,
  items: [{ id: 'a', label: 'Check belt wear', order: 0 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  getType.mockResolvedValue(TYPE)
  updateType.mockImplementation(async (_db, _id, patch) => ({ ...TYPE, ...patch }))
  countActiveAssetsOfType.mockResolvedValue(0)
})

describe('PATCH /api/equipment/types/[id]', () => {
  it('returns 404 (NOT 403) for a type at another location', async () => {
    getType.mockResolvedValue({ ...TYPE, location_id: 'loc-OTHER' })
    const res = await PATCH(req({ name: 'New name' }), ctx)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found.')
    expect(updateType).not.toHaveBeenCalled()
  })

  it('returns 404 for a type id that does not exist', async () => {
    getType.mockResolvedValue(null)
    const res = await PATCH(req({ name: 'New name' }), ctx)
    expect(res.status).toBe(404)
    expect(updateType).not.toHaveBeenCalled()
  })

  it('updates a same-location type', async () => {
    const res = await PATCH(req({ name: 'Rower' }), ctx)
    expect(res.status ?? 200).toBe(200)
    expect(updateType).toHaveBeenCalledWith({}, 'type-1', expect.objectContaining({ name: 'Rower' }))
  })
})

describe('DELETE /api/equipment/types/[id]', () => {
  it('returns 404 (NOT 403) for a type at another location', async () => {
    getType.mockResolvedValue({ ...TYPE, location_id: 'loc-OTHER' })
    const res = await DELETE(req(null), ctx)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found.')
    expect(updateType).not.toHaveBeenCalled()
  })

  it('returns 404 for a type id that does not exist', async () => {
    getType.mockResolvedValue(null)
    const res = await DELETE(req(null), ctx)
    expect(res.status).toBe(404)
    expect(updateType).not.toHaveBeenCalled()
  })

  it('soft-disables a same-location type with no active assets', async () => {
    const res = await DELETE(req(null), ctx)
    expect(res.status ?? 200).toBe(200)
    expect(updateType).toHaveBeenCalledWith({}, 'type-1', { enabled: false })
  })

  it('refuses with 409 while non-retired assets still use the type', async () => {
    countActiveAssetsOfType.mockResolvedValue(2)
    const res = await DELETE(req(null), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/still use this type/)
    expect(updateType).not.toHaveBeenCalled()
  })
})
