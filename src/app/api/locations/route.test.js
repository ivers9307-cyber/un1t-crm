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

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { seedLocationDefaults } from '@/lib/location-seed'

const ORG = 'c0000000-0000-0000-0000-000000000001'
const LOC = 'a0000000-0000-0000-0000-000000000001'
const NEW_ID = 'b0000000-0000-0000-0000-00000000beef'

const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master',
  locations: [{ id: LOC, organization_id: ORG }], rolesByLocation: {},
  activeLocation: { id: LOC }, activeOrganization: { id: ORG },
}
const OWNER = { ...MASTER, role: 'owner', profileRole: 'owner' }

// The insert's `.select()` names no columns, so the created row carries
// every locations column — the seed reads `name` and `is_host_anchor` off it.
function makeDb({ insertError = null } = {}) {
  const inserts = []
  return {
    inserts,
    from(table) {
      if (table !== 'locations') throw new Error(`unexpected db.from('${table}') in POST /api/locations test`)
      const b = {
        insert: (row) => { inserts.push(row); return b },
        select: () => b,
        single: () => Promise.resolve(insertError
          ? { data: null, error: insertError }
          : { data: { id: NEW_ID, is_host_anchor: false, features: {}, notification_config: null, ...inserts.at(-1) }, error: null }),
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
    expect(body.data).toMatchObject({ id: NEW_ID, name: 'Gym A North', slug: 'gym-a-north', is_host_anchor: false })

    expect(seedLocationDefaults).toHaveBeenCalledTimes(1)
    const [seedDb, seedRow] = seedLocationDefaults.mock.calls[0]
    expect(seedDb).toBe(db)
    // The seed reads these three: a row without them would silently skip
    // the W1.W1 settings seed (name → company_name, is_host_anchor → gate).
    expect(seedRow).toMatchObject({ id: NEW_ID, name: 'Gym A North', is_host_anchor: false })
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
