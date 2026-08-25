// Route test for issue resolve.
//
// Focus: the issue.resolved audit event must NOT pass the issue UUID as
// target.id (audit_events.target_profile_id FK → profiles — a non-profile
// UUID silently drops the row). Issue identity rides in target.resource.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const OWNER = { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' }

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) =>
    handler({
      user: h.user,
      db: {},
      locationId: h.locationId,
      request,
      params: ctx?.params ? await ctx.params : undefined,
    }),
}))
vi.mock('@/lib/issues', () => ({
  resolveIssue: vi.fn(),
  getInboxIssue: vi.fn(),
}))
vi.mock('@/lib/push-dedup', () => ({ sendPushOnce: vi.fn(async () => ({ sent: 1 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/equipment-db', () => ({ getEquipment: vi.fn(), updateEquipment: vi.fn() }))

import { POST } from './route.js'
import { resolveIssue, getInboxIssue } from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'
import { getEquipment, updateEquipment } from '@/lib/equipment-db'

const ISSUE = {
  id: 'issue-1',
  description: 'Treadmill 3 squeaks at speed',
  location_id: 'loc-1',
  submitter_id: 'prof-coach',
  status: 'in_progress',
}

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.user = OWNER // the granted-handler cases below swap this; don't leak it
  getInboxIssue.mockResolvedValue(ISSUE)
  resolveIssue.mockResolvedValue({
    ok: true,
    data: { id: 'issue-1', status: 'resolved', resolution_notes: 'Re-tensioned the belt' },
  })
  getEquipment.mockResolvedValue(null)
  updateEquipment.mockResolvedValue({})
})

describe('POST /api/issues/[id]/resolve', () => {
  it('audits issue.resolved with an issue resource target and no target.id', async () => {
    const res = await POST(req({ notes: 'Re-tensioned the belt' }), { params: { id: 'issue-1' } })
    const body = await res.json()
    expect(body).toMatchObject({ success: true })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'issue.resolved',
      actor: expect.objectContaining({ id: 'prof-owner' }),
      target: expect.objectContaining({ label: ISSUE.description, resource: 'issue/issue-1' }),
      locationId: 'loc-1',
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })

  it('returns the asset to service when the resolved issue is what removed it', async () => {
    getInboxIssue.mockResolvedValue({ ...ISSUE, equipment_id: 'eq-1' })
    getEquipment.mockResolvedValue({
      id: 'eq-1', status: 'out_of_service', out_of_service_issue_id: 'issue-1',
    })
    await POST(req({ notes: 'Belt replaced' }), { params: { id: 'issue-1' } })
    expect(updateEquipment).toHaveBeenCalledWith(expect.anything(), 'eq-1', {
      status: 'in_service', out_of_service_issue_id: null,
    })
  })

  it('leaves an asset alone when a DIFFERENT issue took it off the floor', async () => {
    getInboxIssue.mockResolvedValue({ ...ISSUE, equipment_id: 'eq-1' })
    getEquipment.mockResolvedValue({
      id: 'eq-1', status: 'out_of_service', out_of_service_issue_id: 'issue-OTHER',
    })
    await POST(req({ notes: 'unrelated' }), { params: { id: 'issue-1' } })
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  it('does not touch equipment for an ordinary issue with no equipment link', async () => {
    getInboxIssue.mockResolvedValue({ ...ISSUE, equipment_id: null })
    await POST(req({ notes: 'done' }), { params: { id: 'issue-1' } })
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  // HUBDOOR.2 — the return-to-service side effect carries its OWN
  // equipment_admin check, because HUBDOOR.1 widened the resolve gate to
  // honour `issues_inbox` and equipment_admin defaults FALSE for manager
  // and head_coach. Without this, granting the issues key would silently
  // also grant a register mutation that PATCH /api/equipment/[id] refuses.
  // Permissions are not mocked: the real resolver runs off the fixture.
  describe('equipment return-to-service is gated on equipment_admin, not on being a handler', () => {
    const grantedHandler = (perms) => ({
      id: 'prof-hc',
      full_name: 'Hank Coach',
      email: 'hank@un1t.ie',
      role: 'head_coach',
      activeLocation: { id: 'loc-1', features: {} },
      activeAssignment: { permissions: perms },
    })

    beforeEach(() => {
      getInboxIssue.mockResolvedValue({ ...ISSUE, equipment_id: 'eq-1' })
      getEquipment.mockResolvedValue({
        id: 'eq-1', status: 'out_of_service', out_of_service_issue_id: 'issue-1',
      })
    })

    it('a head_coach granted only issues_inbox resolves the issue but leaves the asset off the floor', async () => {
      h.user = grantedHandler({ issues_inbox: true }) // equipment_admin: false by role default
      const res = await POST(req({ notes: 'Looks fine to me' }), { params: { id: 'issue-1' } })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toMatchObject({ success: true })
      expect(resolveIssue).toHaveBeenCalled()
      expect(updateEquipment).not.toHaveBeenCalled()
    })

    it('the same handler ALSO holding equipment_admin does return it to service', async () => {
      h.user = grantedHandler({ issues_inbox: true, equipment_admin: true })
      await POST(req({ notes: 'Belt replaced' }), { params: { id: 'issue-1' } })
      expect(updateEquipment).toHaveBeenCalledWith(expect.anything(), 'eq-1', {
        status: 'in_service', out_of_service_issue_id: null,
      })
    })
  })
})
