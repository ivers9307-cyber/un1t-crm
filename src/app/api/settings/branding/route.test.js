// BRANDMERGE.1 — PUT /api/settings/branding wrote explicit NULLs for all three
// branding columns on every save (`body.x ?? null`), while the Zod schema
// advertises all three as optional. Nothing was broken in production because
// the one caller, BrandingSettings.jsx, posts all three every time — so the
// route's correctness was a property of a component, and any second caller
// (mobile, an org-level tool, a script) would have wiped a studio's logo and
// received a 200.
//
// What is pinned here: an ABSENT key leaves the column alone, an EXPLICIT null
// clears it, the full payload the current UI sends still behaves identically,
// and the location gate still runs first.
//
// @/lib/auth is mocked with a real-equivalent assertLocationAccess (inlined to
// keep its next/headers import out of the node test env).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    return null
  },
}))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const OWNER = { id: 'u1', role: 'owner', locations: [{ id: LOC_A }], activeLocation: { id: LOC_A } }

function makeDb() {
  const upserts = []
  return {
    upserts,
    from() {
      const b = {
        upsert: (payload, opts) => { upserts.push({ payload, opts }); return b },
        select: () => b,
        single: () => Promise.resolve({ data: { location_id: LOC_A }, error: null }),
      }
      return b
    },
  }
}

const put = (body) => new Request('http://localhost/api/settings/branding', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER)
})

describe('PUT /api/settings/branding — a partial save must not wipe branding', () => {
  it('writes ONLY the keys the caller sent', async () => {
    const res = await PUT(put({ location_id: LOC_A, company_name: 'UN1T Stillorgan' }))
    expect(res.status).toBe(200)

    const { payload } = db.upserts[0]
    expect(payload.company_name).toBe('UN1T Stillorgan')
    expect('logo_url' in payload).toBe(false)
    expect('favicon_url' in payload).toBe(false)
  })

  it('never turns an absent key into an explicit null', async () => {
    await PUT(put({ location_id: LOC_A, logo_url: 'https://cdn.example/logo.png' }))
    const { payload } = db.upserts[0]
    expect(Object.values(payload)).not.toContain(null)
  })

  it('an EXPLICIT null still clears the field, which is how the UI removes a logo', async () => {
    await PUT(put({ location_id: LOC_A, logo_url: null }))
    const { payload } = db.upserts[0]
    expect('logo_url' in payload).toBe(true)
    expect(payload.logo_url).toBeNull()
  })

  it('the full payload the branding form sends behaves exactly as before', async () => {
    await PUT(put({
      location_id: LOC_A,
      logo_url: 'https://cdn.example/logo.png',
      favicon_url: 'https://cdn.example/fav.png',
      company_name: 'UN1T',
    }))
    const { payload } = db.upserts[0]
    expect(payload).toMatchObject({
      location_id: LOC_A,
      logo_url: 'https://cdn.example/logo.png',
      favicon_url: 'https://cdn.example/fav.png',
      company_name: 'UN1T',
      updated_by: 'u1',
    })
  })

  it('always stamps who changed it and when, even on a one-field save', async () => {
    await PUT(put({ location_id: LOC_A, company_name: 'UN1T' }))
    const { payload, opts } = db.upserts[0]
    expect(payload.updated_by).toBe('u1')
    expect(payload.updated_at).toEqual(expect.any(String))
    expect(payload.location_id).toBe(LOC_A)
    expect(opts).toEqual({ onConflict: 'location_id' })
  })
})

describe('PUT /api/settings/branding — access control still runs first', () => {
  it('403s a non-owner without writing', async () => {
    getCurrentUser.mockResolvedValue({ ...OWNER, role: 'manager' })
    expect((await PUT(put({ location_id: LOC_A, company_name: 'X' }))).status).toBe(403)
    expect(db.upserts).toEqual([])
  })

  it('403s another location without writing', async () => {
    const res = await PUT(put({ location_id: LOC_B, company_name: 'X' }))
    expect(res.status).toBe(403)
    expect(db.upserts).toEqual([])
  })

  // The route folds "no session" into its owner check, so an anonymous caller
  // gets 403 rather than 401. Pinned as-is: it is a pre-existing status-code
  // wart, not a hole, and changing it is not this task.
  it('refuses an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(put({ company_name: 'X' }))).status).toBe(403)
    expect(db.upserts).toEqual([])
  })
})
