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
  assertLocationAccessOr404: (user, locationId) => {
    if (user?.role === 'master') return null
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 404 })
  },
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// ROLESWEEP.1a — the route's pre-check is hasPermissionAtAnyLocation and its
// decision hasPermissionForLocation; all three share one mock so the
// "whatsapp permission is off" switch below still switches the gate.
vi.mock('@/lib/permissions', () => {
  const perm = vi.fn()
  return { hasPermission: perm, hasPermissionAtAnyLocation: perm, hasPermissionForLocation: perm }
})
vi.mock('@/lib/whatsapp', () => ({ sendBroadcast: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { sendBroadcast } from '@/lib/whatsapp'

// A table-aware fake: the broadcast read (.maybeSingle), the studio read the
// sign-off gate makes (WAORGNUMBER.4) and the stamp write. `location` omitted
// = a studio with no sign-off window. Writes land on `writes`.
function mockDb({ broadcast, location, locationError = null, stampError = null, writes = [] } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'locations') {
        const b = { select: () => b, eq: () => b,
          maybeSingle: () => Promise.resolve(locationError ? { data: null, error: locationError }
            : { data: location || { id: broadcast?.location_id, name: 'Studio', organization_id: 'org-1', timezone: 'Europe/Dublin', settings: {} }, error: null }) }
        return b
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: broadcast || null, error: null })),
          })),
        })),
        update: vi.fn((patch) => ({
          eq: vi.fn(() => ({
            select: vi.fn(() => { writes.push(patch); return Promise.resolve(stampError ? { data: null, error: stampError } : { data: [{ id: 'b1' }], error: null }) }),
          })),
        })),
      }
    }),
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

  it('404 when the broadcast belongs to another location — cross-tenant send blocked', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-OTHER' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const res = await POST(req(), props)
    expect(res.status).toBe(404)
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it('sends when the caller is assigned to the broadcast location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(sendBroadcast).toHaveBeenCalledWith('b1', { force: false })
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('master can send for any location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'master', locations: [] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(sendBroadcast).toHaveBeenCalledWith('b1', { force: false })
  })

  // WA-QUALITY.2 — quality-gate override: only an explicit JSON `force: true`
  // bypasses the RED-number preflight refusal inside sendBroadcast.
  it('passes force: true through to sendBroadcast when the body asks for it', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const request = new Request('http://localhost/api/whatsapp/broadcasts/b1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })
    const res = await POST(request, props)
    expect(res.status).toBe(200)
    expect(sendBroadcast).toHaveBeenCalledWith('b1', { force: true })
  })

  it('a non-boolean force is not honoured', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    const request = new Request('http://localhost/api/whatsapp/broadcasts/b1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: 'yes' }),
    })
    await POST(request, props)
    expect(sendBroadcast).toHaveBeenCalledWith('b1', { force: false })
  })
})

// WACONFIGFALLBACK.1 — sendBroadcast refuses (before any status flip) at a
// location with no WhatsApp number of its own; the route says so with a 409.
describe('POST /api/whatsapp/broadcasts/[id]/send — no WhatsApp number', () => {
  it('409 with the resolver message', async () => {
    const { WhatsAppNumberMissingError } = await import('@/lib/whatsapp-number-missing')
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    sendBroadcast.mockRejectedValueOnce(new WhatsAppNumberMissingError('loc-1'))
    const res = await POST(req(), props)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
  })

  it('any other refusal keeps its 400', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1' } }))
    sendBroadcast.mockRejectedValueOnce(new Error('Template not approved by Meta'))
    const res = await POST(req(), props)
    expect(res.status).toBe(400)
  })
})

// WAORGNUMBER.4 (R7) — blast sign-off at a studio new to a shared number.
describe('POST /api/whatsapp/broadcasts/[id]/send — blast sign-off', () => {
  // Fictional ids only: the repo is public.
  const hatch = (until) => ({ id: 'loc-1', name: 'UN1T Hatch Street', organization_id: 'org-1', timezone: 'Europe/Dublin',
    settings: { whatsapp_blast_signoff_until: until } })
  const OPEN = '2999-11-16'
  const manager = { id: 'u-m', role: 'manager', locations: [{ id: 'loc-1' }] }
  const orgAdmin = { id: 'u-a', role: 'manager', locations: [{ id: 'loc-1' }], orgAdminOrgIds: ['org-1'] }

  it('manager gets 403 with the copy while the window is open; nothing is sent', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1', signed_off_by: null }, location: hatch(OPEN) }))
    const res = await POST(req(), props)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2999.')
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it('org admin send stamps signed_off_by, then sends', async () => {
    const writes = []
    getCurrentUser.mockResolvedValue(orgAdmin)
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1', signed_off_by: null }, location: hatch(OPEN), writes }))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(writes).toEqual([{ signed_off_by: 'u-a', signed_off_at: expect.any(String) }])
    expect(sendBroadcast).toHaveBeenCalledWith('b1', { force: false })
  })

  it('a manager may send a broadcast an org admin signed off', async () => {
    const writes = []
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1', signed_off_by: 'u-a' }, location: hatch(OPEN), writes }))
    expect((await POST(req(), props)).status).toBe(200)
    expect(writes).toEqual([])
  })

  it('window past → no gate', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1', signed_off_by: null }, location: hatch('2020-01-01') }))
    expect((await POST(req(), props)).status).toBe(200)
    expect(sendBroadcast).toHaveBeenCalled()
  })

  it('a failed studio read refuses (503) and sends nothing', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1', signed_off_by: null }, locationError: { message: 'boom' } }))
    expect((await POST(req(), props)).status).toBe(503)
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it('a failed stamp write refuses (500) and sends nothing', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin)
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1', signed_off_by: null }, location: hatch(OPEN), stampError: { message: 'boom' } }))
    expect((await POST(req(), props)).status).toBe(500)
    expect(sendBroadcast).not.toHaveBeenCalled()
  })

  it("the engine's sign-off refusal is a 409", async () => {
    const { BlastSignoffRequiredError } = await import('@/lib/whatsapp-blast-signoff')
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(mockDb({ broadcast: { location_id: 'loc-1', signed_off_by: null } }))
    sendBroadcast.mockRejectedValueOnce(new BlastSignoffRequiredError('Blasts at X need sign-off'))
    expect((await POST(req(), props)).status).toBe(409)
  })
})
