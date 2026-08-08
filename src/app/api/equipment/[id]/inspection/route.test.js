// EQUIP-MAINT.2 — route tests for the draft create-or-resume route.
//
// This route runs on the service-role client (no RLS), so the
// location check in app code is the only IDOR guard — 404 not 403.
// buildDraftRow (equipment-inspections.js) is left un-mocked so the
// "no checklist items" 409 exercises the real throw, not a stub of it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-staff', full_name: 'Sam Staff', email: 'sam@un1t.ie', role: 'staff' },
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
  getType: vi.fn(),
  getDraftFor: vi.fn(),
  insertDraft: vi.fn(),
}))

import { POST } from './route.js'
import { getEquipment, getType, getDraftFor, insertDraft } from '@/lib/equipment-db'

function req() {
  return { headers: { get: () => null } }
}
const ctx = { params: { id: 'eq-1' } }

const ASSET = {
  id: 'eq-1',
  location_id: 'loc-1',
  type_id: 'type-1',
  name: 'Treadmill 3',
  status: 'in_service',
  next_due_on: '2026-07-28',
}
const TYPE = {
  id: 'type-1',
  location_id: 'loc-1',
  name: 'Treadmill',
  items: [{ id: 'i1', label: 'Check belt', order: 0 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  getEquipment.mockResolvedValue(ASSET)
  getType.mockResolvedValue(TYPE)
  getDraftFor.mockResolvedValue(null)
  insertDraft.mockImplementation(async (_db, row) => ({ id: 'insp-new', ...row }))
})

describe('POST /api/equipment/[id]/inspection', () => {
  it('returns 404 (NOT 403) for an asset at another location', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, location_id: 'loc-OTHER' })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
    expect(insertDraft).not.toHaveBeenCalled()
  })

  it('returns 404 for an id that does not exist', async () => {
    getEquipment.mockResolvedValue(null)
    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 409 for an out-of-service asset', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, status: 'out_of_service' })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(insertDraft).not.toHaveBeenCalled()
  })

  it('mints a new draft when none exists for this cycle', async () => {
    const res = await POST(req(), ctx)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(insertDraft).toHaveBeenCalledTimes(1)
    expect(body.data.id).toBe('insp-new')
  })

  it('a second POST returns the SAME draft id rather than minting another', async () => {
    const existing = { id: 'insp-existing', status: 'draft', equipment_id: 'eq-1', due_on: '2026-07-28' }
    getDraftFor.mockResolvedValue(existing)
    const res = await POST(req(), ctx)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.id).toBe('insp-existing')
    expect(insertDraft).not.toHaveBeenCalled()
  })

  it('returns 409 when the existing draft for this cycle was already submitted', async () => {
    getDraftFor.mockResolvedValue({ id: 'insp-old', status: 'submitted' })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(insertDraft).not.toHaveBeenCalled()
  })

  it('returns 409 naming the setup gap for a type with no checklist items', async () => {
    getType.mockResolvedValue({ ...TYPE, items: [] })
    const res = await POST(req(), ctx)
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error).toMatch(/no checklist items/i)
    expect(body.error).toMatch(/Equipment setup/)
    expect(insertDraft).not.toHaveBeenCalled()
  })
})
