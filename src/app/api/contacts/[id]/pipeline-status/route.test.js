// Tests for POST /api/contacts/[id]/pipeline-status (FUNNEL.4 — Cold toggle)
//
// Coverage:
//   - { cold: true }  → sets pipeline_dismissed_at (non-null) + moves the deal
//   - { cold: false } → clears pipeline_dismissed_at (null)
//   - missing `pipeline` permission → 403
//   - contact outside caller's location → 404 (location scope)
//   - missing contact → 404
//   - non-boolean `cold` → 400 (Zod)
//   - a deal-placement throw does not fail the (already-saved) dismissal

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/glofox-sync', () => ({ ensureDealForContact: vi.fn(() => Promise.resolve({ action: 'move', to_slug: 'cold_lead' })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { ensureDealForContact } from '@/lib/glofox-sync'

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const OTHER_LOC  = 'd0000000-0000-0000-0000-000000000004'
const CONTACT = { id: CONTACT_ID, location_id: LOC_ID, name: 'Wendy', glofox_membership_status: 'lead' }
const STAFF = { id: 'u1', role: 'staff', locations: [{ id: LOC_ID }] }

function makeDb(updateSpy, contact = CONTACT) {
  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: contact, error: null })) })),
          })),
          update: vi.fn((payload) => ({
            eq: vi.fn(() => { updateSpy(payload); return Promise.resolve({ error: null }) }),
          })),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

function req(body) {
  return new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
const props = { params: Promise.resolve({ id: CONTACT_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(STAFF)
  hasPermission.mockReturnValue(true)
})

describe('POST /api/contacts/[id]/pipeline-status', () => {
  it('cold:true sets pipeline_dismissed_at and moves the deal', async () => {
    const updateSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(updateSpy))
    const res = await POST(req({ cold: true }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][0].pipeline_dismissed_at).toBeTruthy()
    expect(json.data.cold).toBe(true)
    expect(ensureDealForContact).toHaveBeenCalledTimes(1)
    // the snapshot passed to the classifier carries the fresh dismissal
    expect(ensureDealForContact.mock.calls[0][3].pipeline_dismissed_at).toBeTruthy()
  })

  it('cold:false clears pipeline_dismissed_at (null)', async () => {
    const updateSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(updateSpy))
    const res = await POST(req({ cold: false }), props)
    expect(res.status).toBe(200)
    expect(updateSpy.mock.calls[0][0].pipeline_dismissed_at).toBeNull()
  })

  it('missing pipeline permission → 403', async () => {
    hasPermission.mockReturnValue(false)
    createServerClient.mockReturnValue(makeDb(vi.fn()))
    const res = await POST(req({ cold: true }), props)
    expect(res.status).toBe(403)
  })

  it('contact outside caller location → 404', async () => {
    createServerClient.mockReturnValue(makeDb(vi.fn(), { ...CONTACT, location_id: OTHER_LOC }))
    const res = await POST(req({ cold: true }), props)
    expect(res.status).toBe(404)
  })

  it('non-boolean cold → 400', async () => {
    createServerClient.mockReturnValue(makeDb(vi.fn()))
    const res = await POST(req({ cold: 'yes' }), props)
    expect(res.status).toBe(400)
  })

  it('a deal-placement throw still returns success (dismissal already saved)', async () => {
    const updateSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(updateSpy))
    ensureDealForContact.mockRejectedValueOnce(new Error('boom'))
    const res = await POST(req({ cold: true }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.deal.action).toBe('error')
  })
})
