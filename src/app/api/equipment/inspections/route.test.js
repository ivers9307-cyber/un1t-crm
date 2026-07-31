// EQUIP-MAINT.3 — route test for the compliance log.
//
// Focus: pagination params are parsed/clamped and passed through to
// listInspectionLog, and the response carries total/limit/offset
// alongside the rows so the tab can drive Previous/Next.

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
  listInspectionLog: vi.fn(),
}))

import { GET } from './route.js'
import { listInspectionLog } from '@/lib/equipment-db'

function req(qs = '') {
  return { url: `https://crm.un1tdublin.com/api/equipment/inspections${qs}`, headers: { get: () => null } }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/equipment/inspections', () => {
  it('defaults to limit 50, offset 0, no equipment filter', async () => {
    listInspectionLog.mockResolvedValue({ rows: [], total: 0 })
    await GET(req(), {})
    expect(listInspectionLog).toHaveBeenCalledWith({}, 'loc-1', { limit: 50, offset: 0, equipmentId: null })
  })

  it('passes through limit, offset and equipmentId from the query string', async () => {
    listInspectionLog.mockResolvedValue({ rows: [], total: 0 })
    await GET(req('?limit=10&offset=20&equipmentId=eq-1'), {})
    expect(listInspectionLog).toHaveBeenCalledWith({}, 'loc-1', { limit: 10, offset: 20, equipmentId: 'eq-1' })
  })

  it('clamps limit to MAX_LIMIT (100) rather than trusting the caller', async () => {
    listInspectionLog.mockResolvedValue({ rows: [], total: 0 })
    await GET(req('?limit=9999'), {})
    expect(listInspectionLog).toHaveBeenCalledWith({}, 'loc-1', { limit: 100, offset: 0, equipmentId: null })
  })

  it('floors a negative offset at 0', async () => {
    listInspectionLog.mockResolvedValue({ rows: [], total: 0 })
    await GET(req('?offset=-5'), {})
    expect(listInspectionLog).toHaveBeenCalledWith({}, 'loc-1', { limit: 50, offset: 0, equipmentId: null })
  })

  it('returns rows, total, limit and offset in the response', async () => {
    listInspectionLog.mockResolvedValue({ rows: [{ id: 'insp-1' }], total: 137 })
    const res = await GET(req('?limit=10&offset=20'), {})
    const body = await res.json()
    expect(body).toEqual({
      success: true,
      data: { rows: [{ id: 'insp-1' }], total: 137, limit: 10, offset: 20 },
    })
  })
})
