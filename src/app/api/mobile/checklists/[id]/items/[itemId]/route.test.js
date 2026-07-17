// Route test for the mobile checklist tick endpoint.
//
// Focus: the checklist.completed / checklist.item_ticked audit events must
// NOT pass the checklist_instance UUID as target.id —
// audit_events.target_profile_id has an FK to profiles, so a non-profile
// UUID there violates audit_events_target_profile_id_fkey and the audit row
// is silently dropped. The coach already rides in actor; the instance
// identity rides in target.resource.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/checklist-instances', () => ({ tickItem: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { tickItem } from '@/lib/checklist-instances'
import { logAuditEvent } from '@/lib/audit'

const USER = { id: 'prof-coach', full_name: 'Casey Coach', email: 'casey@un1t.ie' }

function req(body) {
  return {
    method: 'POST',
    json: async () => body,
    headers: { get: () => null },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  tickItem.mockResolvedValue({
    ok: true,
    data: {
      id: 'inst-1',
      status: 'complete',
      location_id: 'loc-1',
      items: [{ id: 'a' }, { id: 'b' }],
      items_checked: { a: true, b: true },
    },
  })
})

describe('POST /api/mobile/checklists/[id]/items/[itemId]', () => {
  it('401s without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ checked: true }), { params: { id: 'inst-1', itemId: 'a' } })
    expect(res.status).toBe(401)
  })

  it('audits the tick with an instance resource target and no target.id', async () => {
    const res = await POST(req({ checked: true }), { params: { id: 'inst-1', itemId: 'b' } })
    const body = await res.json()
    expect(body).toMatchObject({ success: true })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'checklist.completed',
      actor: expect.objectContaining({ id: 'prof-coach' }),
      target: expect.objectContaining({ label: 'Checklist', resource: 'checklist_instance/inst-1' }),
      locationId: 'loc-1',
    }))
    // Instance ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id and violates its FK to profiles.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})
