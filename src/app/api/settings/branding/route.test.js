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
// and the gate runs before any write.
//
// MAILFIX-BRANDGATE.1 — THE GATE IS THE POINT of the second half of this file.
// `user.role` resolves at the caller's ACTIVE location (with a highest-role-
// anywhere fallback), while this route writes to the caller-named
// body.location_id — so gating on `user.role` let an owner at studio A who is
// plain STAFF at studio B set B's email signature (the phone + links
// MAIL-SIG.2 injects into every customer email B sends), logo and company
// name. The gate is now membership + owner-or-master AT THE TARGET
// (assertLocationAccess then guardMasterOrOwner, the guardMailboxAdmin order).
// Every refusal test asserts NO WRITE HAPPENED, not merely the status code.
//
// @/lib/auth is the REAL module (importActual) with only getCurrentUser
// mocked, so these tests exercise the real guards' contracts — a hand-rolled
// stand-in here would let the guard drift out from under the suite.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

// assertLocationAccess reads user.locations; guardMasterOrOwner reads
// user.profileRole + user.rolesByLocation[locationId]. `role` is the
// active-location-resolved value the OLD gate trusted — kept on every
// fixture so a regression back to `user.role` is visible.
const OWNER_A = {
  id: 'u1', role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — owner at their active studio A, plain staff at B. Their
// `user.role` is 'owner' (resolved at A), so the old gate waved them through
// to write B. profileRole is 'owner' too (estate role), which must NOT count:
// only 'master' bypasses the per-location check.
const OWNER_A_STAFF_B = {
  id: 'u2', role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
// The mirror image — staff at the ACTIVE studio, owner at the target. The old
// gate refused them (user.role = 'staff'); the target-role gate lets them in,
// which is what "owner of studio B" is supposed to mean.
const STAFF_A_OWNER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'owner' },
  activeLocation: { id: LOC_A },
}
const MANAGER_A = {
  id: 'u4', role: 'manager', profileRole: 'manager',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
// Masters have no per-location rows — profileRole alone must carry them.
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master',
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

function makeDb() {
  const upserts = []
  return {
    upserts,
    from(table) {
      // Fail LOUD on any table this route has no business touching — a
      // permissive double is how a wrong-table write sails through green.
      if (table !== 'company_settings') throw new Error(`unexpected db.from('${table}') in branding PUT test`)
      const b = {
        upsert: (payload, opts) => { upserts.push({ payload, opts }); return b },
        select: () => b,
        single: () => Promise.resolve({ data: { location_id: (upserts.at(-1)?.payload.location_id) || LOC_A }, error: null }),
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
  getCurrentUser.mockResolvedValue(OWNER_A)
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

  it('the success body an owner sees is byte-identical to before the gate rework', async () => {
    const res = await PUT(put({ location_id: LOC_A, company_name: 'UN1T' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { location_id: LOC_A } })
  })
})

describe('PUT /api/settings/branding — the gate is the role AT THE TARGET studio', () => {
  it('refuses an owner-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(put({ location_id: LOC_B, email_signature: { phone: '01 000 0000', links: [{ label: 'Book', url: 'https://phish.example/book' }] } }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners or master can update branding')
    expect(db.upserts).toEqual([])
  })

  it('lets an owner AT THE TARGET through even when their active studio is elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const res = await PUT(put({ location_id: LOC_B, company_name: 'UN1T Hatch Street' }))
    expect(res.status).toBe(200)
    expect(db.upserts[0].payload.location_id).toBe(LOC_B)
  })

  it('a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(put({ location_id: LOC_B, company_name: 'UN1T' }))
    expect(res.status).toBe(200)
    expect(db.upserts[0].payload.location_id).toBe(LOC_B)
  })

  it('an owner omitting location_id still lands on their active studio', async () => {
    const res = await PUT(put({ company_name: 'UN1T' }))
    expect(res.status).toBe(200)
    expect(db.upserts[0].payload.location_id).toBe(LOC_A)
  })

  it('403s a manager at the target without writing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(put({ location_id: LOC_A, company_name: 'X' }))
    expect(res.status).toBe(403)
    expect(db.upserts).toEqual([])
  })

  it('403s a non-member on the MEMBERSHIP message, not a role complaint that confirms the studio exists', async () => {
    // Owner of A only, aiming at B: assertLocationAccess answers first
    // (guardMailboxAdmin order) so they are told "not one of your locations".
    const res = await PUT(put({ location_id: LOC_B, company_name: 'X' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/location/i)
    expect(db.upserts).toEqual([])
  })

  // Was 403 (the old gate folded "no session" into its role check — pinned
  // then as a status-code wart). The reworked gate answers an anonymous
  // caller 401 like every other route in the house, GET on this same file
  // included.
  it('401s an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(put({ company_name: 'X' }))).status).toBe(401)
    expect(db.upserts).toEqual([])
  })

  it('400s when no target studio can be resolved at all (no field, no active location)', async () => {
    getCurrentUser.mockResolvedValue({ ...MASTER, activeLocation: null })
    const res = await PUT(put({ company_name: 'X' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('location_id is required')
    expect(db.upserts).toEqual([])
  })
})
