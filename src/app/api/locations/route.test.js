// W1.W1 — POST /api/locations is the ONE hook point for per-location seeding
// (SAAS4-W0.1 moved creation out of LocationForm's browser insert; the wizard
// and LocationForm both post here). This is the route's first test file, so
// it pins only what the seed contract needs: the route hands the CREATED row
// (`.select().single()` after the insert, so `name` and `is_host_anchor` are
// on it) to seedLocationDefaults, and a seed failure answers the
// 500-with-row shape so the operator can re-run a safe, idempotent seed.
//
// @/lib/auth is the REAL module with only getCurrentUser mocked (the
// settings/branding pattern); @/lib/location-seed is mocked whole because
// its own contract lives in src/lib/location-seed.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/location-seed', () => ({ seedLocationDefaults: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { makeFakeDb } from '@/lib/api-auth.test-helpers'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { seedLocationDefaults } from '@/lib/location-seed'
import { logError } from '@/lib/log'

const ORG = 'c0000000-0000-0000-0000-000000000001'
const LOC = 'a0000000-0000-0000-0000-000000000001'
const NEW_ID = 'b0000000-0000-0000-0000-00000000beef'

const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master',
  locations: [{ id: LOC, organization_id: ORG }], rolesByLocation: {},
  activeLocation: { id: LOC }, activeOrganization: { id: ORG },
}
const OWNER = { ...MASTER, role: 'owner', profileRole: 'owner' }

// The insert's `.select()` must name no columns, so the created row carries
// every locations column — the seed reads `name` and `is_host_anchor` off it.
// The double records the select argument so the test can pin that (a fake
// that fabricated `is_host_anchor` would pass even if the route selected
// only `id, slug`); the fabricated row carries only what the insert wrote
// plus the db-generated id.
function makeDb({ insertError = null, pages = [], pageStudios = [], pageInsertError = null, studioRowInsertError = null } = {}) {
  const inserts = []
  const selects = []
  // PAGES.1: landing_pages / landing_page_studios are filter-aware in-memory
  // tables (the hook reads them before it writes), ids stamped on insert.
  const tables = { landing_pages: pages, landing_page_studios: pageStudios }
  const fake = makeFakeDb(tables)
  let pageSeq = 0
  return {
    inserts,
    selects,
    tables,
    from(table) {
      if (table === 'landing_pages' || table === 'landing_page_studios') {
        const b = fake.from(table)
        const insert = b.insert
        b.insert = (rows) => {
          const failure = table === 'landing_pages' ? pageInsertError : studioRowInsertError
          if (failure) {
            const failed = { select: () => failed, single: async () => ({ data: null, error: failure }), then: (ok, bad) => Promise.resolve({ error: failure }).then(ok, bad) }
            return failed
          }
          for (const r of Array.isArray(rows) ? rows : [rows]) if (table === 'landing_pages') r.id ??= `page-${++pageSeq}`
          return insert(rows)
        }
        return b
      }
      if (table !== 'locations') throw new Error(`unexpected db.from('${table}') in POST /api/locations test`)
      const b = {
        insert: (row) => { inserts.push(row); return b },
        select: (cols) => { selects.push(cols); return b },
        single: () => Promise.resolve(insertError
          ? { data: null, error: insertError }
          : { data: { id: NEW_ID, ...inserts.at(-1) }, error: null }),
      }
      return b
    },
  }
}

const post = (body) => new Request('http://localhost/api/locations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const VALID = { name: 'Gym A North', organization_id: ORG }

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MASTER)
  seedLocationDefaults.mockResolvedValue(undefined)
})

describe('POST /api/locations — gate', () => {
  it('401s with no session and seeds nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(post(VALID))
    expect(res.status).toBe(401)
    expect(db.inserts).toEqual([])
    expect(seedLocationDefaults).not.toHaveBeenCalled()
  })

  it('403s a non-master (owner) and seeds nothing', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await POST(post(VALID))
    expect(res.status).toBe(403)
    expect(db.inserts).toEqual([])
    expect(seedLocationDefaults).not.toHaveBeenCalled()
  })
})

describe('POST /api/locations — seeds the created row', () => {
  it('calls seedLocationDefaults with the db and the CREATED row (id, name, is_host_anchor on it)', async () => {
    const res = await POST(post(VALID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ id: NEW_ID, name: 'Gym A North', slug: 'gym-a-north' })

    // Column-less `.select()` after the insert: the seed reads `name` and
    // `is_host_anchor` off the created row, and a narrowed select would
    // silently skip the W1.W1 settings seed (name → company_name,
    // is_host_anchor → gate). Pinned on the argument, not the fake's row.
    expect(db.selects).toEqual([undefined])

    expect(seedLocationDefaults).toHaveBeenCalledTimes(1)
    const [seedDb, seedRow] = seedLocationDefaults.mock.calls[0]
    expect(seedDb).toBe(db)
    expect(seedRow).toMatchObject({ id: NEW_ID, name: 'Gym A North' })
    // The row the seed saw is the row the caller gets back.
    expect(body.data).toEqual(seedRow)
  })

  it('answers 500 WITH the created row when the seed throws, naming the id and that a re-run is safe', async () => {
    seedLocationDefaults.mockRejectedValue(new Error('company_settings seed failed: permission denied'))
    const res = await POST(post(VALID))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toMatchObject({ id: NEW_ID, name: 'Gym A North' })
    expect(body.error).toContain(NEW_ID)
    expect(body.error).toContain('company_settings seed failed: permission denied')
    expect(body.error).toMatch(/re-running the seed is safe/i)
  })

  it('does not seed when the insert itself fails (409 on a duplicate slug)', async () => {
    createServerClient.mockReturnValue(makeDb({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "locations_slug_key"' } }))
    const res = await POST(post(VALID))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('duplicate_slug')
    expect(seedLocationDefaults).not.toHaveBeenCalled()
  })
})

// TZ.2 (D1 = A, D8): the zone is any IANA zone canonicalZone() accepts, stored
// in its canonical spelling; fixed offsets and unknown names are refused before
// any write (mig 719's trigger is the DB-side twin of the same check).
describe('POST /api/locations — timezone (TZ.2)', () => {
  it('canonicalises a valid zone', async () => {
    const res = await POST(post({ ...VALID, timezone: 'america/new_york' }))
    expect(res.status).toBe(200)
    expect(db.inserts[0].timezone).toBe('America/New_York')
  })

  it('stores the canonical spelling of a renamed zone (Asia/Kolkata → the runtime canonical)', async () => {
    const res = await POST(post({ ...VALID, timezone: 'Asia/Kolkata' }))
    expect(res.status).toBe(200)
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(db.inserts[0].timezone)
  })

  it.each(['Mars/Olympus', '+05:30', 'Etc/GMT-5', 'UTC+1', 'GMT-3', '', '   '])('refuses %j with 400 and inserts nothing', async (tz) => {
    const res = await POST(post({ ...VALID, timezone: tz }))
    expect(res.status).toBe(400)
    expect(db.inserts).toEqual([])
    expect(seedLocationDefaults).not.toHaveBeenCalled()
  })

  it('names the problem in the 400', async () => {
    const res = await POST(post({ ...VALID, timezone: 'Mars/Olympus' }))
    expect(JSON.stringify(await res.json())).toMatch(/Choose a real timezone/)
  })

  it('defaults to Europe/Dublin only when the field is absent (the CRM forms always send it, D8)', async () => {
    const res = await POST(post(VALID))
    expect(res.status).toBe(200)
    expect(db.inserts[0].timezone).toBe('Europe/Dublin')
  })

  it('passes country through unchanged next to the zone', async () => {
    const res = await POST(post({ ...VALID, timezone: 'Australia/Perth', country: 'au' }))
    expect(res.status).toBe(200)
    expect(db.inserts[0]).toMatchObject({ timezone: 'Australia/Perth', country: 'AU' })
  })
})

// PAGES.1 (R7): the new location's public studio page, in the same request.
describe('POST /api/locations — the studio page (PAGES.1)', () => {
  it('creating a location creates its draft studio page', async () => {
    const res = await POST(post(VALID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warnings).toBeUndefined()

    expect(db.tables.landing_pages).toHaveLength(1)
    const page = db.tables.landing_pages[0]
    expect(page).toMatchObject({
      organization_id: ORG, slug: 'gym-a-north', title: 'Gym A North', kind: 'studio', scope: 'one',
      primary_location_id: NEW_ID, offer_type: 'none', publish_state: 'draft',
      chrome: { tone: 'dark', noindex: false, show_instagram_feed: true },
      created_by: 'u5', updated_by: 'u5',
    })
    expect(page.blocks.map((b) => b.type)).toEqual(['hero', 'booking', 'pillars', 'stats', 'testimonial'])
    // Its one studio row: this studio, switched on.
    expect(db.tables.landing_page_studios).toEqual([
      { page_id: page.id, location_id: NEW_ID, enabled: true, offer: {}, attribution: {}, sort_order: 0, updated_by: 'u5' },
    ])
  })

  it('a taken slug gets a numeric suffix; a reserved one too', async () => {
    createServerClient.mockReturnValue(db = makeDb({
      pages: [
        { id: 'p0', organization_id: ORG, slug: 'gym-a-north', kind: 'studio' },
        { id: 'p1', organization_id: ORG, slug: 'gym-a-north-2', kind: 'campaign' },
        // Another organisation's page at the same slug does not count.
        { id: 'p2', organization_id: 'other-org', slug: 'gym-a-south', kind: 'studio' },
      ],
    }))
    await POST(post(VALID))
    expect(db.tables.landing_pages.at(-1).slug).toBe('gym-a-north-3')

    createServerClient.mockReturnValue(db = makeDb())
    await POST(post({ ...VALID, name: 'Gym A South' }))
    expect(db.tables.landing_pages.at(-1).slug).toBe('gym-a-south')

    // 'settings' is a route segment, so a studio called Settings starts at settings-2.
    createServerClient.mockReturnValue(db = makeDb())
    await POST(post({ ...VALID, name: 'Settings' }))
    expect(db.tables.landing_pages.at(-1).slug).toBe('settings-2')
  })

  it('a name with no usable slug makes no page and warns (the location still exists)', async () => {
    const res = await POST(post({ ...VALID, name: 'A' }))
    expect(res.status).toBe(200)
    expect((await res.json()).warnings).toEqual(['studio_page_not_created'])
    expect(db.tables.landing_pages).toEqual([])
    expect(db.tables.landing_page_studios).toEqual([])
  })

  it('a failed page insert still answers success with a warning, and logs ids only', async () => {
    createServerClient.mockReturnValue(db = makeDb({ pageInsertError: { code: '42501', message: 'permission denied for table landing_pages' } }))
    const res = await POST(post(VALID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ id: NEW_ID })
    expect(body.warnings).toEqual(['studio_page_not_created'])
    expect(logError).toHaveBeenCalledWith('locations', 'new studio page not created', { locationId: NEW_ID, reason: 'failed', code: '42501' })
    expect(db.tables.landing_page_studios).toEqual([])
  })

  it('a failed studio-row insert removes the page again, so no page exists without its row', async () => {
    createServerClient.mockReturnValue(db = makeDb({ studioRowInsertError: { code: '23514', message: 'not in org' } }))
    const res = await POST(post(VALID))
    expect((await res.json()).warnings).toEqual(['studio_page_not_created'])
    expect(db.tables.landing_pages).toEqual([])
  })

  it('an unreadable page table is a warning, not a failed create', async () => {
    const real = db
    createServerClient.mockReturnValue({
      ...real,
      from: (t) => {
        if (t === 'landing_pages') throw Object.assign(new Error('down'), { code: 'XX' })
        return real.from(t)
      },
    })
    const res = await POST(post(VALID))
    expect(res.status).toBe(200)
    expect((await res.json()).warnings).toEqual(['studio_page_not_created'])
  })

  it('adds a switched-off row for the new studio to every all-studios page of the organisation', async () => {
    createServerClient.mockReturnValue(db = makeDb({
      pages: [
        { id: 'all-1', organization_id: ORG, scope: 'all', slug: 'trial', kind: 'campaign' },
        { id: 'all-2', organization_id: ORG, scope: 'all', slug: 'corp', kind: 'campaign' },
        { id: 'one-1', organization_id: ORG, scope: 'one', slug: 'summer', kind: 'campaign' },
        { id: 'all-other', organization_id: 'other-org', scope: 'all', slug: 'trial', kind: 'campaign' },
      ],
      pageStudios: [
        { page_id: 'all-1', location_id: LOC, enabled: true, sort_order: 0 },
        { page_id: 'all-1', location_id: 'loc-b', enabled: false, sort_order: 4 },
        { page_id: 'all-2', location_id: LOC, enabled: true, sort_order: 0 },
        // all-2 already holds a row for the new location (a retry): not doubled.
        { page_id: 'all-2', location_id: NEW_ID, enabled: false, sort_order: 1 },
      ],
    }))
    await POST(post(VALID))
    const added = db.tables.landing_page_studios.filter((r) => r.location_id === NEW_ID && r.page_id !== 'all-2' && !r.enabled)
    expect(added).toEqual([
      { page_id: 'all-1', location_id: NEW_ID, enabled: false, offer: {}, attribution: {}, sort_order: 5, updated_by: 'u5' },
    ])
    expect(db.tables.landing_page_studios.filter((r) => r.page_id === 'all-2' && r.location_id === NEW_ID)).toHaveLength(1)
    // Nothing for the other org's page, nor the one-studio page.
    expect(db.tables.landing_page_studios.some((r) => r.page_id === 'all-other' || r.page_id === 'one-1')).toBe(false)
    // The new studio's own page row is the enabled one.
    expect(db.tables.landing_page_studios.filter((r) => r.location_id === NEW_ID && r.enabled)).toHaveLength(1)
  })

  it('an inactive location gets its page but no all-studios rows', async () => {
    createServerClient.mockReturnValue(db = makeDb({
      pages: [{ id: 'all-1', organization_id: ORG, scope: 'all', slug: 'trial', kind: 'campaign' }],
    }))
    await POST(post({ ...VALID, active: false }))
    expect(db.tables.landing_pages.filter((p) => p.kind === 'studio')).toHaveLength(1)
    expect(db.tables.landing_page_studios.some((r) => r.page_id === 'all-1')).toBe(false)
  })

  it('a failure adding the all-studios rows is logged and never fails the create', async () => {
    createServerClient.mockReturnValue(db = makeDb({
      pages: [{ id: 'all-1', organization_id: ORG, scope: 'all', slug: 'trial', kind: 'campaign' }],
      studioRowInsertError: { code: '23514', message: 'boom' },
    }))
    const res = await POST(post(VALID))
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalled()
  })

  it('writes no page when the location insert fails or the seed throws', async () => {
    createServerClient.mockReturnValue(db = makeDb({ insertError: { code: '23505', message: 'duplicate key' } }))
    await POST(post(VALID))
    expect(db.tables.landing_pages).toEqual([])
    createServerClient.mockReturnValue(db = makeDb())
    seedLocationDefaults.mockRejectedValue(new Error('seed failed'))
    await POST(post(VALID))
    expect(db.tables.landing_pages).toEqual([])
  })
})
