// EQUIP-MAINT.2 — route tests for the submit route: the riskiest code
// in this PR. Ordering is load-bearing (issue THEN inspection/asset
// writes) so several tests assert not just the status code but which
// downstream calls did or didn't happen.
//
// @/lib/equipment and @/lib/dublin-time are left un-mocked — they're
// pure — so rollForward's RangeError guard and validateResults'
// missing/failed split are exercised for real, not stubbed to always
// pass.

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
  updateEquipment: vi.fn(),
}))
vi.mock('@/lib/issues', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, insertIssueWithAttachments: vi.fn() }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => ({ sent: 0 })) }))

import { POST } from './route.js'
import { getInspection, updateInspection, updateEquipment } from '@/lib/equipment-db'
import { insertIssueWithAttachments } from '@/lib/issues'
import { rollForward } from '@/lib/equipment'
import { dublinTodayStr } from '@/lib/dublin-time'

const ctx = { params: { id: 'insp-1' } }

const ASSET = {
  id: 'eq-1',
  name: 'Treadmill 3',
  location_id: 'loc-1',
  status: 'in_service',
  next_due_on: '2026-07-28',
}
const TYPE = { id: 'type-1', name: 'Treadmill', interval_weeks: 4 }
const ITEMS = [
  { id: 'i1', label: 'Check belt', order: 0 },
  { id: 'i2', label: 'Check brakes', order: 1 },
]
const INSPECTION = {
  id: 'insp-1',
  location_id: 'loc-1',
  equipment_id: 'eq-1',
  type_id: 'type-1',
  due_on: '2026-07-28',
  items: ITEMS,
  results: {},
  status: 'draft',
  equipment: ASSET,
  equipment_types: TYPE,
}

// A form with .get(key), mirroring the multipart FormData contract the
// route relies on — no photo entries by default (none of these cases
// need them: pure-pass and pure-fail paths never touch photoFiles).
function form(fields) {
  return { get: (key) => (key in fields ? fields[key] : null) }
}
function req(fields) {
  return { formData: async () => form(fields), headers: { get: () => null } }
}

const ALL_PASS = { i1: { state: 'pass' }, i2: { state: 'pass' } }
const ONE_FAIL = { i1: { state: 'fail', note: 'Belt is fraying' }, i2: { state: 'pass' } }

beforeEach(() => {
  vi.clearAllMocks()
  getInspection.mockResolvedValue(INSPECTION)
  updateInspection.mockImplementation(async (_db, id, patch) => ({ id, ...patch }))
  updateEquipment.mockImplementation(async (_db, id, patch) => ({ id, ...patch }))
  insertIssueWithAttachments.mockResolvedValue({
    ok: true,
    issue: { id: 'iss-1', location_id: 'loc-1', equipment_id: 'eq-1' },
    attachments: [],
  })
})

describe('POST /api/equipment/inspections/[id]/submit', () => {
  it('returns 404 (NOT 403) for an inspection at another location', async () => {
    getInspection.mockResolvedValue({ ...INSPECTION, location_id: 'loc-OTHER' })
    const res = await POST(req({ results: JSON.stringify(ALL_PASS) }), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 409 for an already-submitted inspection', async () => {
    getInspection.mockResolvedValue({ ...INSPECTION, status: 'submitted' })
    const res = await POST(req({ results: JSON.stringify(ALL_PASS) }), ctx)
    expect(res.status).toBe(409)
  })

  it('returns 400 and lists `missing` for an unmarked item', async () => {
    const res = await POST(req({ results: JSON.stringify({ i1: { state: 'pass' } }) }), ctx)
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.missing).toEqual(['i2'])
    expect(updateInspection).not.toHaveBeenCalled()
    expect(updateEquipment).not.toHaveBeenCalled()
    expect(insertIssueWithAttachments).not.toHaveBeenCalled()
  })

  it('an all-pass run creates no issue but still rolls next_due_on forward', async () => {
    const res = await POST(req({ results: JSON.stringify(ALL_PASS) }), ctx)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(insertIssueWithAttachments).not.toHaveBeenCalled()
    expect(body.data.issueId).toBeNull()

    const expectedNextDue = rollForward({ dueOn: '2026-07-28', intervalWeeks: 4, today: dublinTodayStr() })
    const equipPatch = updateEquipment.mock.calls.at(-1)[2]
    expect(equipPatch.next_due_on).toBe(expectedNextDue)

    const inspPatch = updateInspection.mock.calls.at(-1)[2]
    expect(inspPatch.status).toBe('submitted')
    expect(inspPatch.issue_id).toBeNull()
  })

  it('a run with a failure creates exactly one issue carrying equipment_id', async () => {
    const res = await POST(req({ results: JSON.stringify(ONE_FAIL) }), ctx)
    expect(res.status).toBe(200)
    expect(insertIssueWithAttachments).toHaveBeenCalledTimes(1)
    const call = insertIssueWithAttachments.mock.calls[0][1]
    expect(call.equipmentId).toBe('eq-1')

    const inspPatch = updateInspection.mock.calls.at(-1)[2]
    expect(inspPatch.issue_id).toBe('iss-1')
  })

  it('takeOutOfService with no failure does NOT take the asset out of service', async () => {
    await POST(req({ results: JSON.stringify(ALL_PASS), takeOutOfService: 'true' }), ctx)
    expect(insertIssueWithAttachments).not.toHaveBeenCalled()
    const equipPatch = updateEquipment.mock.calls.at(-1)[2]
    expect(equipPatch).not.toHaveProperty('status')
    expect(equipPatch).not.toHaveProperty('out_of_service_issue_id')
  })

  it('takeOutOfService WITH a failure DOES take the asset out of service', async () => {
    await POST(req({ results: JSON.stringify(ONE_FAIL), takeOutOfService: 'true' }), ctx)
    const equipPatch = updateEquipment.mock.calls.at(-1)[2]
    expect(equipPatch.status).toBe('out_of_service')
    expect(equipPatch.out_of_service_issue_id).toBe('iss-1')
  })

  it('a type with interval_weeks: 0 returns 400, not 500', async () => {
    getInspection.mockResolvedValue({ ...INSPECTION, equipment_types: { ...TYPE, interval_weeks: 0 } })
    const res = await POST(req({ results: JSON.stringify(ALL_PASS) }), ctx)
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/invalid inspection interval/i)
    expect(updateInspection).not.toHaveBeenCalled()
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  it('a failed issue insert leaves the inspection draft and does not advance the asset', async () => {
    insertIssueWithAttachments.mockResolvedValue({ ok: false, status: 500, error: 'insert boom' })
    const res = await POST(req({ results: JSON.stringify(ONE_FAIL) }), ctx)
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.error).toBe('insert boom')
    expect(updateInspection).not.toHaveBeenCalled()
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed results JSON', async () => {
    const res = await POST(req({ results: '{not json' }), ctx)
    expect(res.status).toBe(400)
    expect(updateInspection).not.toHaveBeenCalled()
  })
})
