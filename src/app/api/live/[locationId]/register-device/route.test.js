// src/app/api/live/[locationId]/register-device/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc1']),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const props = { params: Promise.resolve({ locationId: 'loc1' }) }
function reqWith(body) {
  return new Request('http://localhost/api/live/loc1/register-device', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
beforeEach(() => { vi.clearAllMocks(); getUserLocationIds.mockReturnValue(['loc1']) })

describe('POST /api/live/[locationId]/register-device', () => {
  it('403 for a non-coach role', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', isMaster: false })
    const res = await POST(reqWith({ device_key: 'ant:1', contact_id: '00000000-0000-0000-0000-000000000001' }), props)
    expect(res.status).toBe(403)
  })

  it('404 when the contact is not at this location (IDOR guard)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'coach', isMaster: false })
    createServerClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'c1', location_id: 'other' }, error: null }) }) }) }),
    })
    const res = await POST(reqWith({ device_key: 'ant:1', contact_id: '00000000-0000-0000-0000-000000000001' }), props)
    expect(res.status).toBe(404)
  })

  it('200 upserts a contact_devices row', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'coach', isMaster: false })
    let upserted = null
    createServerClient.mockReturnValue({
      from: (table) => {
        if (table === 'contacts') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'c1', location_id: 'loc1' }, error: null }) }) }) }
        }
        return {
          upsert: (row, opts) => { upserted = { row, opts }; return { select: () => ({ single: () => Promise.resolve({ data: { id: 'dev1' }, error: null }) }) } },
        }
      },
    })
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: '00000000-0000-0000-0000-000000000001', device_type: 'watch', label: 'Garmin' }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, device_id: 'dev1' })
    expect(upserted.row).toMatchObject({ contact_id: '00000000-0000-0000-0000-000000000001', identifier: 'ant:45075', device_type: 'watch', label: 'Garmin', is_active: true, added_by_contact: false, added_by_user_id: 'u1' })
    expect(upserted.opts).toEqual({ onConflict: 'contact_id,device_type,identifier' })
  })
})
