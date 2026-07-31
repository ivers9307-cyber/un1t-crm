// EQUIP-MAINT.1f — route tests for the equipment register list/create.
//
// Two findings from final review, both covered here:
//   - POST must refuse (409) when the location has no equipment_settings
//     row yet, rather than silently registering an asset whose weekday
//     never gets corrected (equipment-dates.js firstDueOn's `today`
//     fallback claims a later roll-forward fixes it — it never does,
//     since rollForward adds whole weeks and never receives
//     inspectionDayOfWeek).
//   - POST with a typeId belonging to another location must 404, not
//     leak via a different status (the standard 404-not-403 IDOR
//     posture for cross-location ids in this codebase).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
}))

// withAuth mock: mirrors the real wrapper by parsing the body through
// the schema option and exposing it as ctx.input.
vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) => {
    let input
    if (opts?.schema) {
      const parsed = opts.schema.safeParse(await request.json())
      if (!parsed.success) {
        return {
          status: 400,
          json: async () => ({ success: false, error: 'Invalid body.', issues: parsed.error.issues }),
        }
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
  listEquipment: vi.fn(),
  insertEquipment: vi.fn(),
  getType: vi.fn(),
  getSettings: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { GET, POST } from './route.js'
import { listEquipment, insertEquipment, getType, getSettings } from '@/lib/equipment-db'

function req(body, url = 'http://localhost/api/equipment') {
  return { json: async () => body, url, headers: { get: () => null } }
}

const TYPE = { id: 'type-1', location_id: 'loc-1', name: 'Treadmill', enabled: true, interval_weeks: 4 }
const SETTINGS = { location_id: 'loc-1', inspection_day_of_week: 2, enabled: true }

const VALID = { typeId: 'type-1', name: 'Treadmill 3' }

beforeEach(() => {
  vi.clearAllMocks()
  listEquipment.mockResolvedValue([])
  getType.mockResolvedValue(TYPE)
  getSettings.mockResolvedValue(SETTINGS)
  insertEquipment.mockResolvedValue({ id: 'eq-1', name: 'Treadmill 3', next_due_on: '2026-08-04' })
})

describe('POST /api/equipment', () => {
  it('registers the asset when a settings row already exists', async () => {
    const res = await POST(req(VALID))
    expect(res.status ?? 200).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(insertEquipment).toHaveBeenCalled()
  })

  it('refuses with 409 when the studio has no inspection-day settings yet', async () => {
    getSettings.mockResolvedValue(null)
    const res = await POST(req(VALID))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Set your studio inspection day before registering equipment.')
    expect(insertEquipment).not.toHaveBeenCalled()
  })

  it('returns 404 (NOT 403) for a typeId belonging to another location', async () => {
    getType.mockResolvedValue({ ...TYPE, location_id: 'loc-OTHER' })
    const res = await POST(req(VALID))
    expect(res.status).toBe(404)
    expect(insertEquipment).not.toHaveBeenCalled()
  })

  it('returns 404 for a typeId that does not exist', async () => {
    getType.mockResolvedValue(null)
    const res = await POST(req(VALID))
    expect(res.status).toBe(404)
    expect(insertEquipment).not.toHaveBeenCalled()
  })

  it('refuses with 409 when the type is disabled', async () => {
    getType.mockResolvedValue({ ...TYPE, enabled: false })
    const res = await POST(req(VALID))
    expect(res.status).toBe(409)
    expect(insertEquipment).not.toHaveBeenCalled()
  })
})

describe('GET /api/equipment', () => {
  it('lists non-retired equipment by default', async () => {
    await GET(req(null))
    expect(listEquipment).toHaveBeenCalledWith({}, 'loc-1', { includeRetired: false })
  })
})
