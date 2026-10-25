// WAORGNUMBER.4 (R7) — POST /api/whatsapp/broadcasts/[id]/sign-off.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('next/server')
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: (user, locationId) => {
      if (user?.isMaster) return null
      return (user?.locations || []).some((l) => l.id === locationId)
        ? null : NextResponse.json({ success: false }, { status: 404 })
    },
    // The real rule (src/lib/auth.js): master, or an org admin of that organisation.
    assertOrganizationAdmin: (user, orgId) => {
      if (user?.isMaster) return null
      if (orgId && (user?.orgAdminOrgIds || []).includes(orgId)) return null
      return NextResponse.json({ success: false }, { status: 403 })
    },
  }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { signedContentKey } from '@/lib/whatsapp-blast-signoff'

const HATCH = { id: 'loc-h', name: 'UN1T Hatch Street', organization_id: 'org-1', timezone: 'Europe/Dublin',
  settings: { whatsapp_blast_signoff_until: '2999-11-16' } }

function fakeDb({ row, location = HATCH, updated = true, writeError = null }) {
  const state = { writes: [] }
  return {
    state,
    from: (table) => {
      if (table === 'locations') {
        const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: location, error: null }) }
        return b
      }
      const filters = []
      let patch = null
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push([c, v]); return b },
        update: (p) => { patch = p; return b },
        maybeSingle: async () => ({ data: row, error: null }),
        then: (res, rej) => {
          state.writes.push({ patch, filters })
          const out = writeError ? { data: null, error: writeError }
            : { data: updated ? [{ id: row.id, ...patch }] : [], error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }
}
// The draft's content as the admin's page saw it.
const CONTENT = { template_id: 't1', variable_mapping: { 1: 'first_name' }, header_media_url: null,
  audience_filter: { filters: [], logic: 'and' }, daily_cap: null, per_tick_max: null, updated_at: '2026-10-18T09:00:00.000Z' }
const KEY = signedContentKey(CONTENT)
const call = (key = KEY) => POST(new Request('http://x/api/whatsapp/broadcasts/b1/sign-off', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content_key: key }),
}), { params: Promise.resolve({ id: 'b1' }) })
const admin = { id: 'u-a', locations: [{ id: 'loc-h' }], orgAdminOrgIds: ['org-1'] }
const manager = { id: 'u-m', locations: [{ id: 'loc-h' }], rolesByLocation: { 'loc-h': 'manager' } }

beforeEach(() => vi.clearAllMocks())

describe('POST /api/whatsapp/broadcasts/[id]/sign-off', () => {
  it('admin sign-off on a draft stamps it', async () => {
    getCurrentUser.mockResolvedValue(admin)
    const db = fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'draft' } })
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(200)
    expect(db.state.writes).toEqual([{
      patch: { signed_off_by: 'u-a', signed_off_at: expect.any(String) },
      filters: [['id', 'b1'], ['status', 'draft'], ['updated_at', CONTENT.updated_at]],
    }])
  })
  it('a master passes', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-x', isMaster: true, locations: [] })
    createServerClient.mockReturnValue(fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'scheduled' } }))
    expect((await call()).status).toBe(200)
  })
  it('a manager (no org admin) gets 403 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const db = fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'draft' } })
    createServerClient.mockReturnValue(db)
    expect((await call()).status).toBe(403)
    expect(db.state.writes).toEqual([])
  })
  it("an org admin of another organisation gets 403", async () => {
    getCurrentUser.mockResolvedValue({ ...admin, orgAdminOrgIds: ['org-2'] })
    createServerClient.mockReturnValue(fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'draft' } }))
    expect((await call()).status).toBe(403)
  })
  it('content changed since the admin opened it is a 409 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(admin)
    const db = fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'draft', audience_filter: { filters: [{ field: 'tags', op: 'contains', value: 'all' }], logic: 'and' } } })
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/changed since you opened it/)
    expect(db.state.writes).toEqual([])
  })
  it('no content key is a 400', async () => {
    getCurrentUser.mockResolvedValue(admin)
    createServerClient.mockReturnValue(fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'draft' } }))
    const res = await POST(new Request('http://x/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ id: 'b1' }) })
    expect(res.status).toBe(400)
  })
  it('a sent broadcast is a 409', async () => {
    getCurrentUser.mockResolvedValue(admin)
    createServerClient.mockReturnValue(fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'sent' } }))
    expect((await call()).status).toBe(409)
  })
  it('a lost compare-and-swap is a 409', async () => {
    getCurrentUser.mockResolvedValue(admin)
    createServerClient.mockReturnValue(fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'scheduled' }, updated: false }))
    expect((await call()).status).toBe(409)
  })
  it('a failed write is a 500', async () => {
    getCurrentUser.mockResolvedValue(admin)
    createServerClient.mockReturnValue(fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'draft' }, writeError: { message: 'boom' } }))
    expect((await call()).status).toBe(500)
  })
  it('another studio’s broadcast is a 404', async () => {
    getCurrentUser.mockResolvedValue({ ...admin, locations: [{ id: 'loc-other' }] })
    createServerClient.mockReturnValue(fakeDb({ row: { ...CONTENT, id: 'b1', location_id: 'loc-h', status: 'draft' } }))
    expect((await call()).status).toBe(404)
  })
})
