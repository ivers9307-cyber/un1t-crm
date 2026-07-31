// EQUIP-MAINT.2 — route tests for the one-tick PATCH route.
//
// Uses the schema-aware withAuth mock: this route is gated by a Zod
// `schema`, so a harness that doesn't parse it into ctx.input would
// leave `input` undefined and every assertion here vacuous.

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
  getInspection: vi.fn(),
  updateInspection: vi.fn(),
}))

import { PATCH } from './route.js'
import { getInspection, updateInspection } from '@/lib/equipment-db'

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}
const ctx = { params: { id: 'insp-1' } }

const INSPECTION = {
  id: 'insp-1',
  location_id: 'loc-1',
  equipment_id: 'eq-1',
  due_on: '2026-07-28',
  items: [
    { id: 'i1', label: 'Check belt', order: 0 },
    { id: 'i2', label: 'Check brakes', order: 1 },
  ],
  results: {},
  status: 'draft',
}

beforeEach(() => {
  vi.clearAllMocks()
  getInspection.mockResolvedValue(INSPECTION)
  updateInspection.mockImplementation(async (_db, _id, patch) => ({ ...INSPECTION, ...patch }))
})

describe('PATCH /api/equipment/inspections/[id]', () => {
  it('returns 404 (NOT 403) for an inspection at another location', async () => {
    getInspection.mockResolvedValue({ ...INSPECTION, location_id: 'loc-OTHER' })
    const res = await PATCH(req({ itemId: 'i1', state: 'pass' }), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 409 for an already-submitted inspection', async () => {
    getInspection.mockResolvedValue({ ...INSPECTION, status: 'submitted' })
    const res = await PATCH(req({ itemId: 'i1', state: 'pass' }), ctx)
    expect(res.status).toBe(409)
    expect(updateInspection).not.toHaveBeenCalled()
  })

  it('returns 400 for an itemId absent from the snapshot', async () => {
    const res = await PATCH(req({ itemId: 'not-in-snapshot', state: 'pass' }), ctx)
    expect(res.status).toBe(400)
    expect(updateInspection).not.toHaveBeenCalled()
  })

  it('returns 400 for a fail with no note', async () => {
    const res = await PATCH(req({ itemId: 'i1', state: 'fail' }), ctx)
    expect(res.status).toBe(400)
    expect(updateInspection).not.toHaveBeenCalled()
  })

  it('returns 400 for a fail with a blank/whitespace-only note', async () => {
    const res = await PATCH(req({ itemId: 'i1', state: 'fail', note: '   ' }), ctx)
    expect(res.status).toBe(400)
    expect(updateInspection).not.toHaveBeenCalled()
  })

  it('a successful tick preserves previously-marked items', async () => {
    getInspection.mockResolvedValue({
      ...INSPECTION,
      results: { i1: { state: 'pass', at: '2026-07-28T09:00:00.000Z', by: 'prof-other' } },
    })
    const res = await PATCH(req({ itemId: 'i2', state: 'fail', note: 'Squeaky brake' }), ctx)
    expect(res.status).toBe(200)
    const patch = updateInspection.mock.calls.at(-1)[2]
    expect(patch.results.i1).toEqual({ state: 'pass', at: '2026-07-28T09:00:00.000Z', by: 'prof-other' })
    expect(patch.results.i2).toMatchObject({ state: 'fail', note: 'Squeaky brake' })
  })

  it('records a passing tick', async () => {
    const res = await PATCH(req({ itemId: 'i1', state: 'pass' }), ctx)
    expect(res.status).toBe(200)
    const patch = updateInspection.mock.calls.at(-1)[2]
    expect(patch.results.i1.state).toBe('pass')
    expect(patch.results.i1.note).toBeUndefined()
  })
})
