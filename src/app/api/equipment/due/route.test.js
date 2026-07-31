// EQUIP-MAINT.2 — route tests for the due-list route.
//
// The route's whole job is telling "not set up" apart from "nothing
// due" — a dormant location (no settings row, or enabled: false) must
// come back as { enabled: false }, never an empty due list that reads
// as "all clear".

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
  getSettings: vi.fn(),
  listDueEquipment: vi.fn(),
  listOutOfServiceEquipment: vi.fn(),
}))

import { GET } from './route.js'
import { getSettings, listDueEquipment, listOutOfServiceEquipment } from '@/lib/equipment-db'

function req() {
  return { headers: { get: () => null } }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/equipment/due', () => {
  it('returns enabled: false when there is no settings row at all', async () => {
    getSettings.mockResolvedValue(null)
    const res = await GET(req(), {})
    const body = await res.json()
    expect(body.data.enabled).toBe(false)
    expect(body.data.due).toEqual([])
    expect(body.data.outOfService).toEqual([])
    expect(listDueEquipment).not.toHaveBeenCalled()
    expect(listOutOfServiceEquipment).not.toHaveBeenCalled()
  })

  it('returns enabled: false when the settings row exists but is switched off', async () => {
    getSettings.mockResolvedValue({ location_id: 'loc-1', inspection_day_of_week: 2, enabled: false })
    const res = await GET(req(), {})
    const body = await res.json()
    expect(body.data.enabled).toBe(false)
    expect(listDueEquipment).not.toHaveBeenCalled()
  })

  it('returns the due and out-of-service lists when enabled', async () => {
    getSettings.mockResolvedValue({ location_id: 'loc-1', inspection_day_of_week: 2, enabled: true })
    listDueEquipment.mockResolvedValue([{ id: 'eq-1', name: 'Treadmill 3' }])
    listOutOfServiceEquipment.mockResolvedValue([{ id: 'eq-2', name: 'Rower 1' }])
    const res = await GET(req(), {})
    const body = await res.json()
    expect(body.data.enabled).toBe(true)
    expect(body.data.inspectionDayOfWeek).toBe(2)
    expect(body.data.due).toEqual([{ id: 'eq-1', name: 'Treadmill 3' }])
    expect(body.data.outOfService).toEqual([{ id: 'eq-2', name: 'Rower 1' }])
  })
})
