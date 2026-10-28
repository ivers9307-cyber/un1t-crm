// GET /api/contacts/[id]/messaging — CARDLENS-M.7: the phone composer's
// context for the studio it sends for (?location_id=). The rest of the route's
// permission rules are swept in tests/role-sweep/contact-messaging.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    return allowed ? null : new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  },
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: () => true,
  hasMobilePermissionAtAnyLocation: () => false,
  // `whatsapp` held exactly at the studios in user.whatsappAt.
  hasPermissionForLocation: (u, loc) => (u.whatsappAt || []).includes(loc),
  hasMobilePermissionForLocation: () => false,
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contact-studios', () => ({ hasRelationshipAt: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasRelationshipAt } from '@/lib/contact-studios'

const CONTACT = { id: 'c1', location_id: 'still' }
const FUTURE = new Date(Date.now() + 3_600_000).toISOString()

function mockDb() {
  const eqs = []
  const db = {
    eqs,
    from: vi.fn((table) => {
      const c = {}
      for (const m of ['select', 'order', 'limit']) c[m] = vi.fn(() => c)
      c.eq = vi.fn((col, val) => { eqs.push([table, col, val]); return c })
      const result = table === 'contacts'
        ? { data: CONTACT, error: null }
        : table === 'whatsapp_conversations'
          ? { data: [{ window_expires_at: FUTURE }], error: null }
          : { data: [], error: null }
      c.maybeSingle = vi.fn(() => Promise.resolve(result))
      c.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      return c
    }),
  }
  return db
}

const props = { params: Promise.resolve({ id: 'c1' }) }
const req = (q = '') => new Request(`https://example.com/api/contacts/c1/messaging${q}`)

beforeEach(() => {
  vi.clearAllMocks()
  hasRelationshipAt.mockResolvedValue({ ok: true, at: new Set(['hatch']) })
})

describe('GET /api/contacts/[id]/messaging — ?location_id= (CARDLENS-M.7)', () => {
  it('no location_id: the primary studio, unchanged', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', locations: [{ id: 'still' }], whatsappAt: ['still'] })
    const db = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    expect(db.eqs).toContainEqual(['whatsapp_conversations', 'location_id', 'still'])
    expect(db.eqs).toContainEqual(['whatsapp_templates', 'location_id', 'still'])
    expect(hasRelationshipAt).not.toHaveBeenCalled()
  })

  it('a Hatch coach asking for Hatch, where the person has a row: Hatch\'s window and templates', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', locations: [{ id: 'hatch' }], whatsappAt: ['hatch'] })
    const db = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await GET(req('?location_id=hatch'), props)
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.data.whatsapp.windowOpen).toBe(true)
    expect(db.eqs).toContainEqual(['whatsapp_conversations', 'location_id', 'hatch'])
    expect(db.eqs).toContainEqual(['whatsapp_templates', 'location_id', 'hatch'])
  })

  it('a studio the person has no row at: 404, nothing read', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', locations: [{ id: 'hatch' }], whatsappAt: ['hatch'] })
    hasRelationshipAt.mockResolvedValue({ ok: true, at: new Set() })
    const db = mockDb()
    createServerClient.mockReturnValue(db)
    const res = await GET(req('?location_id=hatch'), props)
    expect(res.status).toBe(404)
    expect(db.eqs.some(([t]) => t === 'whatsapp_templates')).toBe(false)
  })

  it('a studio the caller does not belong to: 404', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', locations: [{ id: 'still' }], whatsappAt: ['still'] })
    createServerClient.mockReturnValue(mockDb())
    expect((await GET(req('?location_id=hatch'), props)).status).toBe(404)
  })

  it('no WhatsApp at the requested studio: 403', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', locations: [{ id: 'hatch' }], whatsappAt: [] })
    createServerClient.mockReturnValue(mockDb())
    expect((await GET(req('?location_id=hatch'), props)).status).toBe(403)
  })

  it('a failed relationship read: 503, never an admit', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', locations: [{ id: 'hatch' }], whatsappAt: ['hatch'] })
    hasRelationshipAt.mockResolvedValue({ ok: false, error: 'boom' })
    createServerClient.mockReturnValue(mockDb())
    expect((await GET(req('?location_id=hatch'), props)).status).toBe(503)
  })
})
