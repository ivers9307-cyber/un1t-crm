// Route-level tests for /api/chooser-settings (SAAS-6).
//
// SECURITY REGRESSION GUARD: chooser_settings is per-ORGANIZATION
// (mig 414; was a singleton) and the pre-SAAS-6 edit gate was
// master-or-ANY-owner — one tenant's owner could edit another
// tenant's front page. These tests pin the org scoping:
//   • org A admin edits org A's row; org B answers 404 (read + write)
//   • an owner WITHIN the org is refused (403, C141 ORGROLE.2: organisation
//     admins only); an owner of ANOTHER org gets 404
//   • legacy master flow (no explicit org → activeOrganization) works
//   • upsert-on-first-edit creates the org's row (id 'org:<uuid>')
//   • tiles are bounded to the org's locations (read filter + write 404)
//   • PAGES.1: a tile is the org's kind='studio' landing_pages row; label, CTA
//     and visibility are written onto it (chrome merged, hidden → draft)
//
// We use the REAL chooser-access helpers + isOrgAdmin —
// only getCurrentUser and the Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, PUT, TileSchema } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000001'
const LOC_A = 'aaaaaaaa-0000-0000-0000-0000000000aa'
const LOC_B = 'bbbbbbbb-0000-0000-0000-0000000000bb'

// ─── fixtures ──────────────────────────────────────────────────────

const orgAAdmin = {
  id: 'admin-a', isMaster: false, role: 'staff',
  rolesByLocation: {}, locations: [],
  orgAdminOrgIds: [ORG_A],
  organizationsById: { [ORG_A]: { id: ORG_A } },
  activeOrganization: { id: ORG_A },
}

const master = {
  id: 'm1', isMaster: true, role: 'master', profileRole: 'master',
  rolesByLocation: {}, locations: [], orgAdminOrgIds: [],
  organizationsById: { [ORG_A]: { id: ORG_A }, [ORG_B]: { id: ORG_B } },
  activeOrganization: { id: ORG_A },
}

// The pre-SAAS-6 hole: an owner in org B, targeting org A.
const orgBOwner = {
  id: 'owner-b', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_B]: 'owner' },
  locations: [{ id: LOC_B, organization_id: ORG_B }],
  orgAdminOrgIds: [],
  organizationsById: { [ORG_B]: { id: ORG_B } },
  activeOrganization: { id: ORG_B },
}

const orgAOwner = {
  id: 'owner-a', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_A]: 'owner' },
  locations: [{ id: LOC_A, organization_id: ORG_A }],
  orgAdminOrgIds: [],
  organizationsById: { [ORG_A]: { id: ORG_A } },
  activeOrganization: { id: ORG_A },
}

const orgAStaff = {
  id: 'staff-a', isMaster: false, role: 'staff',
  rolesByLocation: { [LOC_A]: 'staff' },
  locations: [{ id: LOC_A, organization_id: ORG_A }],
  orgAdminOrgIds: [],
  organizationsById: { [ORG_A]: { id: ORG_A } },
  activeOrganization: { id: ORG_A },
}

// ─── db mock ───────────────────────────────────────────────────────
// Covers every query the route runs; `writes` records mutations so
// tests can assert exactly which row was touched (or that none was).

function makeDb({ chooserRow = null, tiles = [], orgLocations = [] } = {}) {
  const writes = { chooserUpdates: [], chooserInserts: [], tileUpdates: [], tileReads: [] }
  const db = {
    from(table) {
      if (table === 'chooser_settings') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: chooserRow, error: null }) }),
          }),
          update: (patch) => ({
            eq: async (col, val) => { writes.chooserUpdates.push({ patch, col, val }); return { error: null } },
          }),
          insert: async (row) => { writes.chooserInserts.push(row); return { error: null } },
        }
      }
      if (table === 'landing_pages') {
        // Filter-aware: .eq()/.in() really filter the page rows, so a route
        // that forgets the org or kind filter fails here.
        const filters = []
        const rows = () => tiles.filter((r) => filters.every(([c, v]) => (
          Array.isArray(v) ? v.includes(r[c]) : r[c] === v
        )))
        const b = {
          select: () => b,
          eq: (c, v) => { filters.push([c, v]); return b },
          in: (c, v) => { filters.push([c, v]); return b },
          then: (ok, bad) => { writes.tileReads.push([...filters]); return Promise.resolve({ data: rows(), error: null }).then(ok, bad) },
          update: (patch) => {
            const u = { filters: [] }
            const ub = {
              eq: (c, v) => { u.filters.push([c, v]); return ub },
              select: () => ub,
              maybeSingle: async () => {
                writes.tileUpdates.push({ patch, filters: u.filters })
                return { data: { id: u.filters.find(([c]) => c === 'id')?.[1] }, error: null }
              },
            }
            return ub
          },
        }
        return b
      }
      if (table === 'locations') {
        return {
          select: () => ({ eq: () => Promise.resolve({ data: orgLocations, error: null }) }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, writes }
}

// A studio page row as the route reads it.
const page = (over = {}) => ({
  id: 'page-a', organization_id: ORG_A, kind: 'studio', primary_location_id: LOC_A, slug: 'stillorgan',
  chrome: { logo_url: 'https://cdn/logo.png', tone: 'dark' }, publish_state: 'live', locations: { name: 'Stillorgan' },
  ...over,
})

function req(url, { method = 'GET', body } = {}) {
  return new Request(`http://test.local${url}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
}

const emptyPut = { tile_order: [], tiles: [] }

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── schema (pre-existing coverage, kept) ──────────────────────────

describe('chooser-settings TileSchema.publish_state', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    public_path: 'hatch-street',
  }

  it('accepts each valid publish_state', () => {
    for (const s of ['live', 'coming_soon', 'hidden']) {
      expect(() => TileSchema.parse({ ...base, publish_state: s })).not.toThrow()
    }
  })

  it('rejects an invalid publish_state', () => {
    expect(() => TileSchema.parse({ ...base, publish_state: 'bogus' })).toThrow()
  })

  it('allows publish_state to be omitted (back-compat)', () => {
    expect(() => TileSchema.parse({ ...base })).not.toThrow()
  })
})

// ─── org scoping ───────────────────────────────────────────────────

describe('chooser-settings org scoping (SAAS-6)', () => {
  it('org A admin edits org A\'s row (200, write scoped to that row)', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' } })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req(`/api/chooser-settings?organization_id=${ORG_A}`, { method: 'PUT', body: emptyPut }))
    expect(res.status).toBe(200)
    expect(writes.chooserUpdates).toHaveLength(1)
    expect(writes.chooserUpdates[0]).toMatchObject({ col: 'id', val: 'default' })
    expect(writes.chooserInserts).toHaveLength(0)
  })

  it('org A admin CANNOT read org B\'s row — 404', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db } = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await GET(req(`/api/chooser-settings?organization_id=${ORG_B}`))
    expect(res.status).toBe(404)
  })

  it('org A admin CANNOT edit org B\'s row — 404, no writes', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' } })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req(`/api/chooser-settings?organization_id=${ORG_B}`, { method: 'PUT', body: emptyPut }))
    expect(res.status).toBe(404)
    expect(writes.chooserUpdates).toHaveLength(0)
    expect(writes.chooserInserts).toHaveLength(0)
  })

  it('cross-org OWNER hole is closed: org B\'s owner editing org A gets 404 (was allowed pre-SAAS-6)', async () => {
    getCurrentUser.mockResolvedValue(orgBOwner)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' } })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req(`/api/chooser-settings?organization_id=${ORG_A}`, { method: 'PUT', body: emptyPut }))
    expect(res.status).toBe(404)
    expect(writes.chooserUpdates).toHaveLength(0)
    expect(writes.chooserInserts).toHaveLength(0)
  })

  it('C141 — an owner WITHIN the org without an org_admin grant is refused (403, no writes)', async () => {
    getCurrentUser.mockResolvedValue(orgAOwner)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' } })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req('/api/chooser-settings', { method: 'PUT', body: emptyPut }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Organisation admin required')
    expect(writes.chooserUpdates).toHaveLength(0)
    expect(writes.chooserInserts).toHaveLength(0)
  })

  it('a plain org member can GET but not PUT (403 — honest, org is their own)', async () => {
    getCurrentUser.mockResolvedValue(orgAStaff)
    const { db } = makeDb({ chooserRow: { id: 'default', organization_id: ORG_A } })
    createServerClient.mockReturnValue(db)

    const getRes = await GET(req('/api/chooser-settings'))
    expect(getRes.status).toBe(200)

    const putRes = await PUT(req('/api/chooser-settings', { method: 'PUT', body: emptyPut }))
    expect(putRes.status).toBe(403)
  })

  it('legacy master flow: no explicit org targets activeOrganization (GET + PUT 200)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, writes } = makeDb({
      chooserRow: { id: 'default', organization_id: ORG_A, headline: 'H', intro: null, tile_order: ['stillorgan'] },
    })
    createServerClient.mockReturnValue(db)

    const getRes = await GET(req('/api/chooser-settings'))
    const getBody = await getRes.json()
    expect(getRes.status).toBe(200)
    expect(getBody.data.chooser.headline).toBe('H')

    const putRes = await PUT(req('/api/chooser-settings', { method: 'PUT', body: emptyPut }))
    expect(putRes.status).toBe(200)
    expect(writes.chooserUpdates[0]).toMatchObject({ col: 'id', val: 'default' })
  })

  it('401 with no user; 400 when no org can be resolved at all', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req('/api/chooser-settings'))).status).toBe(401)

    getCurrentUser.mockResolvedValue({ ...orgAAdmin, activeOrganization: null, orgAdminOrgIds: [], organizationsById: {} })
    expect((await GET(req('/api/chooser-settings'))).status).toBe(400)
  })
})

// ─── upsert-on-first-edit ──────────────────────────────────────────

describe('chooser-settings upsert-on-first-edit (SAAS-6)', () => {
  it('PUT for an org with no row INSERTs it (id org:<uuid>, organization_id stamped)', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db, writes } = makeDb({ chooserRow: null })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req('/api/chooser-settings', {
      method: 'PUT',
      body: { headline: 'New brand', tile_order: [], tiles: [] },
    }))
    expect(res.status).toBe(200)
    expect(writes.chooserUpdates).toHaveLength(0)
    expect(writes.chooserInserts).toHaveLength(1)
    expect(writes.chooserInserts[0]).toMatchObject({
      id: `org:${ORG_A}`,
      organization_id: ORG_A,
      headline: 'New brand',
    })
  })
})

// ─── tile scoping ──────────────────────────────────────────────────

describe('chooser-settings tile org bounds (SAAS-6)', () => {
  it('GET returns only the org\'s tiles', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db } = makeDb({
      chooserRow: { id: 'default', organization_id: ORG_A, tile_order: [] },
      tiles: [
        page(),
        page({ id: 'page-b', organization_id: ORG_B, primary_location_id: LOC_B, slug: 'rival-gym', locations: { name: 'Rival' } }),
        page({ id: 'page-c', kind: 'campaign', primary_location_id: null, slug: 'summer' }),
      ],
    })
    createServerClient.mockReturnValue(db)

    const res = await GET(req('/api/chooser-settings'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.tiles.map((t) => t.public_path)).toEqual(['stillorgan'])
  })

  it('GET reports a studio page as a tile: chrome.chooser_* fields, draft and retired as hidden', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db } = makeDb({
      chooserRow: { id: 'default', organization_id: ORG_A, tile_order: [] },
      tiles: [
        page({ chrome: { chooser_label: 'STILLORGAN', chooser_cta_text: 'Come in', chooser_image_url: 'https://cdn/c.jpg' } }),
        page({ id: 'p2', primary_location_id: 'l2', slug: 'draft-one', publish_state: 'draft', locations: { name: 'Draft' } }),
        page({ id: 'p3', primary_location_id: 'l3', slug: 'gone-one', publish_state: 'retired', locations: null }),
        page({ id: 'p4', primary_location_id: 'l4', slug: 'soon', publish_state: 'coming_soon', chrome: null, locations: null }),
      ],
    })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req('/api/chooser-settings'))).json()
    expect(body.data.tiles).toEqual([
      { location_id: LOC_A, public_path: 'stillorgan', name: 'Stillorgan', chooser_label: 'STILLORGAN', chooser_cta_text: 'Come in', chooser_image_url: 'https://cdn/c.jpg', publish_state: 'live' },
      { location_id: 'l2', public_path: 'draft-one', name: 'Draft', chooser_label: null, chooser_cta_text: null, chooser_image_url: null, publish_state: 'hidden' },
      { location_id: 'l3', public_path: 'gone-one', name: 'gone-one', chooser_label: null, chooser_cta_text: null, chooser_image_url: null, publish_state: 'hidden' },
      { location_id: 'l4', public_path: 'soon', name: 'soon', chooser_label: null, chooser_cta_text: null, chooser_image_url: null, publish_state: 'coming_soon' },
    ])
  })

  it('PUT refuses a tile whose location is outside the org (404, no writes)', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' }, orgLocations: [{ id: LOC_A }], tiles: [page()] })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req('/api/chooser-settings', {
      method: 'PUT',
      body: { tile_order: [], tiles: [{ location_id: LOC_B, public_path: 'rival-gym' }] },
    }))
    expect(res.status).toBe(404)
    expect(writes.chooserUpdates).toHaveLength(0)
    expect(writes.tileUpdates).toHaveLength(0)
  })

  it('PUT refuses a tile whose studio has no page in the org (404 before ANY write)', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    // LOC_A is the org's, but its only studio page belongs to another org.
    const { db, writes } = makeDb({
      chooserRow: { id: 'default' }, orgLocations: [{ id: LOC_A }],
      tiles: [page({ organization_id: ORG_B })],
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req('/api/chooser-settings', {
      method: 'PUT',
      body: { tile_order: ['stillorgan'], tiles: [{ location_id: LOC_A, public_path: 'stillorgan', chooser_label: 'X' }] },
    }))
    expect(res.status).toBe(404)
    expect(writes.chooserUpdates).toHaveLength(0)
    expect(writes.tileUpdates).toHaveLength(0)
  })

  it('PUT writes a tile\'s label and CTA into the studio page chrome, merged, scoped to the page and the org', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' }, orgLocations: [{ id: LOC_A }], tiles: [page()] })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req('/api/chooser-settings', {
      method: 'PUT',
      body: { tile_order: ['stillorgan'], tiles: [{ location_id: LOC_A, public_path: 'stillorgan', chooser_label: 'STILLORGAN', chooser_cta_text: 'Come in', publish_state: 'live' }] },
    }))
    expect(res.status).toBe(200)
    // The read was kind + org + location.
    expect(writes.tileReads[0]).toEqual([['kind', 'studio'], ['organization_id', ORG_A], ['primary_location_id', [LOC_A]]])
    expect(writes.tileUpdates).toHaveLength(1)
    const { patch, filters } = writes.tileUpdates[0]
    expect(filters).toEqual([['id', 'page-a'], ['organization_id', ORG_A]])
    // Merged: the logo and tone survive; no state change was written (live stays live).
    expect(patch.chrome).toEqual({ logo_url: 'https://cdn/logo.png', tone: 'dark', chooser_label: 'STILLORGAN', chooser_cta_text: 'Come in' })
    expect(patch.publish_state).toBeUndefined()
    expect(patch.updated_by).toBe('admin-a')
  })

  it('PUT maps hidden to draft (clearing redirect_to) and live stamps was_live', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' }, orgLocations: [{ id: LOC_A }], tiles: [page()] })
    createServerClient.mockReturnValue(db)
    const put = (state) => PUT(req('/api/chooser-settings', {
      method: 'PUT',
      body: { tile_order: [], tiles: [{ location_id: LOC_A, public_path: 'stillorgan', publish_state: state }] },
    }))

    expect((await put('hidden')).status).toBe(200)
    expect(writes.tileUpdates[0].patch).toMatchObject({ publish_state: 'draft', redirect_to: null })

    // A draft page sent live: live, and the page remembers it has been public.
    const { db: db2, writes: w2 } = makeDb({ chooserRow: { id: 'default' }, orgLocations: [{ id: LOC_A }], tiles: [page({ publish_state: 'draft' })] })
    createServerClient.mockReturnValue(db2)
    expect((await put('live')).status).toBe(200)
    expect(w2.tileUpdates[0].patch).toMatchObject({ publish_state: 'live', redirect_to: null })
    expect(w2.tileUpdates[0].patch.chrome.was_live).toBe(true)

    const { db: db3, writes: w3 } = makeDb({ chooserRow: { id: 'default' }, orgLocations: [{ id: LOC_A }], tiles: [page()] })
    createServerClient.mockReturnValue(db3)
    expect((await put('coming_soon')).status).toBe(200)
    expect(w3.tileUpdates[0].patch).toMatchObject({ publish_state: 'coming_soon', redirect_to: null })
  })

  it('PUT leaves a retired page retired when its hidden tile is saved as hidden', async () => {
    getCurrentUser.mockResolvedValue(orgAAdmin)
    const { db, writes } = makeDb({ chooserRow: { id: 'default' }, orgLocations: [{ id: LOC_A }], tiles: [page({ publish_state: 'retired' })] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req('/api/chooser-settings', {
      method: 'PUT',
      body: { tile_order: [], tiles: [{ location_id: LOC_A, public_path: 'stillorgan', publish_state: 'hidden', chooser_label: 'S' }] },
    }))
    expect(res.status).toBe(200)
    expect(writes.tileUpdates[0].patch.publish_state).toBeUndefined()
    expect(writes.tileUpdates[0].patch.redirect_to).toBeUndefined()
    expect(writes.tileUpdates[0].patch.chrome.chooser_label).toBe('S')
  })
})
