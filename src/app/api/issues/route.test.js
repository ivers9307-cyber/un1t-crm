// Route test for issue submission.
//
// Focus: the issue.submitted audit event must NOT pass the issue UUID as
// target.id — audit_events.target_profile_id has an FK to profiles, so a
// non-profile UUID there violates audit_events_target_profile_id_fkey and
// the audit row is silently dropped. The issue identity rides in
// target.resource ('issue/<id>').

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
  insertIssueWithAttachments: vi.fn(),
  listMyIssues: vi.fn(async () => []),
  buildAttachmentPath: vi.fn(() => 'path'),
  validateSubmission: vi.fn(),
}))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => ({ sent: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { insertIssueWithAttachments, validateSubmission } from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'

const DESC = 'Treadmill 3 squeaks at speed'

function req() {
  return {
    formData: async () => ({ get: (k) => (k === 'description' ? DESC : null) }),
    headers: { get: () => null },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  validateSubmission.mockReturnValue({ ok: true, normalised: { description: DESC } })
  insertIssueWithAttachments.mockResolvedValue({
    ok: true,
    issue: { id: 'issue-1', description: DESC },
    attachments: [],
  })
})

describe('POST /api/issues', () => {
  it('audits issue.submitted with an issue resource target and no target.id', async () => {
    const res = await POST(req(), {})
    expect(res.status).toBe(201)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'issue.submitted',
      actor: expect.objectContaining({ id: 'prof-owner' }),
      target: expect.objectContaining({ label: DESC, resource: 'issue/issue-1' }),
      locationId: 'loc-1',
    }))
    // Issue ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id and violates its FK to profiles.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})
