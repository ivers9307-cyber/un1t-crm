// Route test for issue claim.
//
// Focus: the issue.claimed audit event must NOT pass the issue UUID as
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
  claimIssue: vi.fn(),
  getInboxIssue: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { claimIssue, getInboxIssue } from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'

const ISSUE = {
  id: 'issue-1',
  description: 'Treadmill 3 squeaks at speed',
  location_id: 'loc-1',
  submitter_id: 'prof-coach',
  status: 'open',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.user = OWNER // cases below swap in a manager fixture; don't leak it
  getInboxIssue.mockResolvedValue(ISSUE)
  claimIssue.mockResolvedValue({ ok: true, data: { id: 'issue-1', status: 'in_progress' } })
})

describe('POST /api/issues/[id]/claim', () => {
  it('audits issue.claimed with an issue resource target and no target.id', async () => {
    const res = await POST({ headers: { get: () => null } }, { params: { id: 'issue-1' } })
    const body = await res.json()
    expect(body).toMatchObject({ success: true })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'issue.claimed',
      actor: expect.objectContaining({ id: 'prof-owner' }),
      target: expect.objectContaining({ label: ISSUE.description, resource: 'issue/issue-1' }),
      locationId: 'loc-1',
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })

  // HUBDOOR.1 — the handler gate moved to the shared isIssueHandler
  // (src/lib/issues-access.js) so the API agrees with the /issues page and
  // the ⌘K palette. Before it, granting the registered `issues_inbox` key
  // to a manager gave them a palette command, a 403 from every route, and
  // a page that redirected them to '/'. Permissions are NOT mocked here —
  // the real resolver runs off the fixture, same as the hub index tests.
  const manager = (perms) => ({
    id: 'prof-mgr',
    full_name: 'Mia Manager',
    email: 'mia@un1t.ie',
    role: 'manager',
    activeLocation: { id: 'loc-1', features: {} },
    activeAssignment: { permissions: perms },
  })

  it('403s a manager who does not hold issues_inbox', async () => {
    h.user = manager({ issues_inbox: false })
    const res = await POST({ headers: { get: () => null } }, { params: { id: 'issue-1' } })
    expect(res.status).toBe(403)
    expect(claimIssue).not.toHaveBeenCalled()
  })

  it('lets a manager GRANTED issues_inbox claim (the key is honoured, not just the role)', async () => {
    h.user = manager({ issues_inbox: true })
    const res = await POST({ headers: { get: () => null } }, { params: { id: 'issue-1' } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true })
    expect(claimIssue).toHaveBeenCalled()
  })
})
