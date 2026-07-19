// Route test for issue resolve.
//
// Focus: the issue.resolved audit event must NOT pass the issue UUID as
// target.id (audit_events.target_profile_id FK → profiles — a non-profile
// UUID silently drops the row). Issue identity rides in target.resource.

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { POST } from './route.js'
import { resolveIssue, getInboxIssue } from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'

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
  getInboxIssue.mockResolvedValue(ISSUE)
  resolveIssue.mockResolvedValue({
    ok: true,
    data: { id: 'issue-1', status: 'resolved', resolution_notes: 'Re-tensioned the belt' },
  })
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
})
