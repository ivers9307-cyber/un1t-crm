// Route test for checklist template edit + soft-delete.
//
// Focus: the checklist_template.updated / .disabled audit events must NOT
// pass the template UUID as target.id (audit_events.target_profile_id FK →
// profiles — a non-profile UUID silently drops the row). Template identity
// rides in target.resource ('checklist_template/<id>').

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
  getTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  disableTemplate: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { PATCH, DELETE } from './route.js'
import { getTemplate, updateTemplate, disableTemplate } from '@/lib/checklists'
import { logAuditEvent } from '@/lib/audit'

const TEMPLATE = {
  id: 'tmpl-1',
  name: 'Morning open',
  role: 'head_coach',
  day_of_week: 1,
  location_id: 'loc-1',
  items: [],
  enabled: true,
}

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}

beforeEach(() => {
  vi.clearAllMocks()
  getTemplate.mockResolvedValue(TEMPLATE)
  updateTemplate.mockResolvedValue({
    ok: true,
    data: { ...TEMPLATE, name: 'Morning open v2' },
  })
  disableTemplate.mockResolvedValue({ ok: true })
})

describe('PATCH /api/checklists/templates/[id]', () => {
  it('audits checklist_template.updated with a template resource target and no target.id', async () => {
    const res = await PATCH(req({ name: 'Morning open v2' }), { params: { id: 'tmpl-1' } })
    const body = await res.json()
    expect(body).toMatchObject({ success: true })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'mutation',
      action: 'checklist_template.updated',
      target: expect.objectContaining({ label: 'Morning open v2', resource: 'checklist_template/tmpl-1' }),
      locationId: 'loc-1',
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})

describe('DELETE /api/checklists/templates/[id]', () => {
  it('audits checklist_template.disabled with a template resource target and no target.id', async () => {
    const res = await DELETE(req(undefined), { params: { id: 'tmpl-1' } })
    const body = await res.json()
    expect(body).toMatchObject({ success: true })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'mutation',
      action: 'checklist_template.disabled',
      target: expect.objectContaining({ label: 'Morning open', resource: 'checklist_template/tmpl-1' }),
      locationId: 'loc-1',
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})
