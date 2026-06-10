// Tests for POST /api/whatsapp/broadcasts/[id]/send — the authz gate
// (2026-06-10 audit). This route previously had NO guard at all: any
// authenticated principal (any role, any org, or a champ-app customer
// JWT) could fire any WhatsApp broadcast by id. It now mirrors the SMS
// sibling: getCurrentUser → hasPermission('whatsapp') → location gate.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Real-shaped stand-in: master passes, otherwise the caller must be
  // assigned to the row's location.
  assertLocationAccess: (user, locationId) => {
    if (user?.role === 'master') return null
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403 })
  },
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ sendBroadcast: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { sendBroadcast } from '@/lib/whatsapp'

function mockDb({ broadcast } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(() =>
            Promise.resolve(
              broadcast
                ? { data: broadcast, error: null }
                : { data: null, error: { message: 'no rows' } }
            )
          ),
        })),
      })),
    })),
  }
}

const req = () =>
  new Request('http://localhost/api/whatsapp/broadcasts/b1/send', { method: 'POST' })
const props = { params: { id: 'b1' } }

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  sendBroadcast.mockResolvedValue({ sent: 3, failed: 0 })
})

describe('POST /api/whatsapp/broadcasts/[id]/send — authz gate', () => {
  it('401 when no user; broadcast not sent', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req(), props)
    expect(res.status).toBe(401)
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it('403 when the whatsapp permission is off; broadcast not sent', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', locations: [{ id: 'loc-1' }] })
    hasPermission.mockReturnValue(false)
    const res = await POST(req(), props)
    expect(res.status).toBe(403)
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it('404 when the broadcast does not exist', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({}))
    const res = await POST(req(), props)
    expect(res.status).toBe(404)
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it('403 when the broadcast belongs to another location — cross-tenant send blocked', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-OTHER' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const res = await POST(req(), props)
    expect(res.status).toBe(403)
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it('sends when the caller is assigned to the broadcast location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(sendBroadcast).toHaveBeenCalledWith('b1')
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('master can send for any location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'master', locations: [] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(sendBroadcast).toHaveBeenCalledWith('b1')
  })
})
