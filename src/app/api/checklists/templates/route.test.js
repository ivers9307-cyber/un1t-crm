// Route test for checklist template creation.
//
// Focus: the checklist_template.created audit event must NOT pass the
// template UUID as target.id (audit_events.target_profile_id FK → profiles —
// a non-profile UUID silently drops the row). Template identity rides in
// target.resource ('checklist_template/<id>').

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
vi.mock('@/lib/checklists', () => ({
  listTemplates: vi.fn(async () => []),
  createTemplate: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { createTemplate } from '@/lib/checklists'
import { logAuditEvent } from '@/lib/audit'

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}

beforeEach(() => {
  vi.clearAllMocks()
  createTemplate.mockResolvedValue({
    ok: true,
    data: { id: 'tmpl-1', name: 'Morning open', role: 'head_coach', day_of_week: 1, items: [] },
  })
})

describe('POST /api/checklists/templates', () => {
  it('audits checklist_template.created with a template resource target and no target.id', async () => {
    const res = await POST(req({ role: 'head_coach', day_of_week: 1, name: 'Morning open' }), {})
    expect(res.status).toBe(201)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'mutation',
      action: 'checklist_template.created',
      actor: expect.objectContaining({ id: 'prof-owner' }),
      target: expect.objectContaining({ label: 'Morning open', resource: 'checklist_template/tmpl-1' }),
      locationId: 'loc-1',
    }))
    // Template ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id and violates its FK to profiles.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})
