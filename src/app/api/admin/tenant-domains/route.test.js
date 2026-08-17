// SAAS-8 — /api/admin/tenant-domains route matrix. Auth is mocked at
// getCurrentUser (the routes' own gate is what's under test), supabase
// is the filter-aware in-memory double. The reserved-hostname guard
// runs against the REAL in-code registry — pinning that the live
// brand hostnames can never be shadowed by a row.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let db
let currentUser
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => currentUser) }))

import { GET, POST } from './route.js'
import { PATCH, DELETE } from './[id]/route.js'

const ORG_ID = 'a0000000-0000-0000-0000-0000000000aa'
const OTHER_ORG_ID = 'a0000000-0000-0000-0000-0000000000ab'
const ROW_ID = 'b0000000-0000-0000-0000-0000000000bb'
const MISSING_ID = 'c0000000-0000-0000-0000-0000000000cc'
const LOC_ID = 'd0000000-0000-0000-0000-0000000000dd'          // belongs to ORG_ID
const OTHER_LOC_ID = 'd0000000-0000-0000-0000-0000000000de'    // belongs to OTHER_ORG_ID

const MASTER = { id: 'u-master', profileRole: 'master' }
const OWNER = { id: 'u-owner', profileRole: 'owner' }

function fixture() {
  return {
    organizations: [
      { id: ORG_ID, name: 'Acme Gyms', slug: 'acme-gyms' },
      { id: OTHER_ORG_ID, name: 'Other Org', slug: 'other-org' },
    ],
    locations: [
      { id: LOC_ID, name: 'Acme Central', organization_id: ORG_ID },
      { id: OTHER_LOC_ID, name: 'Other Studio', organization_id: OTHER_ORG_ID },
    ],
    tenant_domains: [
      { id: ROW_ID, hostname: 'members.acmegym.ie', organization_id: ORG_ID, location_id: null, brand: {}, active: true },
    ],
  }
}

const listReq = () => new Request('http://localhost/api/admin/tenant-domains')
const postReq = (body) =>
  new Request('http://localhost/api/admin/tenant-domains', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const idReq = (method, body) =>
  new Request('http://localhost/api/admin/tenant-domains/x', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const props = (id) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  db = makeFakeDb(fixture())
  currentUser = MASTER
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('auth matrix (401 / 403)', () => {
  it.each([
    ['GET', () => GET(listReq())],
    ['POST', () => POST(postReq({ hostname: 'x.example.com', organization_id: ORG_ID }))],
    ['PATCH', () => PATCH(idReq('PATCH', { active: false }), props(ROW_ID))],
    ['DELETE', () => DELETE(idReq('DELETE'), props(ROW_ID))],
  ])('%s → 401 with no session, 403 for a non-master', async (_name, call) => {
    currentUser = null
    expect((await call()).status).toBe(401)
    currentUser = OWNER
    expect((await call()).status).toBe(403)
  })
})

describe('GET — list', () => {
  it('master sees the mappings', async () => {
    const res = await GET(listReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((r) => r.hostname)).toEqual(['members.acmegym.ie'])
  })
})

describe('POST — create', () => {
  it('creates a mapping; hostname is trimmed + lowercased (matches the DB CHECK)', async () => {
    const res = await POST(postReq({ hostname: '  Pay.AcmeGym.IE ', organization_id: ORG_ID }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.hostname).toBe('pay.acmegym.ie')
    expect(body.data.active).toBe(true)
    expect(db.from('tenant_domains')).toBeTruthy()
  })

  it('accepts a valid brand config', async () => {
    const res = await POST(postReq({
      hostname: 'pay.acmegym.ie',
      organization_id: ORG_ID,
      brand: { rootHandler: 'reject', fallbackHandler: 'reject', allowedPaths: ['/deposit/'] },
    }))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.brand.rootHandler).toBe('reject')
  })

  it('duplicate hostname → clean 409, not a raw Postgres error', async () => {
    const res = await POST(postReq({ hostname: 'members.acmegym.ie', organization_id: ORG_ID }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('duplicate_hostname')
  })

  it('invalid brand jsonb → 400 (unknown key and bad handler both refused)', async () => {
    for (const brand of [{ rootHandler: 'banana' }, { alowedPaths: ['/x/'] }]) {
      const res = await POST(postReq({ hostname: 'pay.acmegym.ie', organization_id: ORG_ID, brand }))
      expect(res.status).toBe(400)
    }
  })

  it('hostname with scheme/port/path shapes → 400', async () => {
    for (const hostname of ['https://x.example.com', 'x.example.com:3000', 'x.example.com/path', 'localhost']) {
      const res = await POST(postReq({ hostname, organization_id: ORG_ID }))
      expect(res.status).toBe(400)
    }
  })

  it('a hostname the in-code registry resolves is refused (no dual-source drift)', async () => {
    const res = await POST(postReq({ hostname: 'pay.ccfautos.com', organization_id: ORG_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('in-code brand registry')
  })

  it('the CRM\'s own hostname is refused (a row would gate the staff CRM)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.un1tdublin.com')
    const res = await POST(postReq({ hostname: 'crm.un1tdublin.com', organization_id: ORG_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("CRM's own hostname")
  })

  // REPSET-P6 — dual-domain: EITHER CRM host as a tenant row would
  // brand-gate the staff CRM on that domain. Both must be refused,
  // even when NEXT_PUBLIC_APP_URL names only one of them (prod
  // config) or is unset entirely (dev/tests).
  it('EVERY CRM host in the set is refused, whatever NEXT_PUBLIC_APP_URL says', async () => {
    for (const appUrl of ['https://crm.un1tdublin.com', undefined]) {
      if (appUrl) vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
      else vi.unstubAllEnvs()
      for (const hostname of ['crm.un1tdublin.com', 'crm.repset.ie']) {
        const res = await POST(postReq({ hostname, organization_id: ORG_ID }))
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain("CRM's own hostname")
      }
    }
  })

  it('CRM hosts are refused case-insensitively (schema lowercases before the guard)', async () => {
    const res = await POST(postReq({ hostname: 'CRM.Repset.IE', organization_id: ORG_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("CRM's own hostname")
  })

  it('unknown organization → 400', async () => {
    const res = await POST(postReq({ hostname: 'pay.acmegym.ie', organization_id: MISSING_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Unknown organization')
  })

  it('no location_id → whole-org row (location_id null), today\'s behaviour', async () => {
    const res = await POST(postReq({ hostname: 'pay.acmegym.ie', organization_id: ORG_ID }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.location_id ?? null).toBe(null)
  })

  it('location_id in the org → persisted (per-location scoping)', async () => {
    const res = await POST(postReq({ hostname: 'pay.acmegym.ie', organization_id: ORG_ID, location_id: LOC_ID }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.location_id).toBe(LOC_ID)
  })

  it('location_id belonging to ANOTHER org → 400 (belongs-to-org validation)', async () => {
    const res = await POST(postReq({ hostname: 'pay.acmegym.ie', organization_id: ORG_ID, location_id: OTHER_LOC_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('does not belong to the selected organization')
  })

  it('unknown location_id → 400', async () => {
    const res = await POST(postReq({ hostname: 'pay.acmegym.ie', organization_id: ORG_ID, location_id: MISSING_ID }))
    expect(res.status).toBe(400)
  })
})

describe('PATCH — update', () => {
  it('unknown id → 404 (detail routes never 403 a missing row)', async () => {
    const res = await PATCH(idReq('PATCH', { active: false }), props(MISSING_ID))
    expect(res.status).toBe(404)
  })

  it('non-uuid id → 404, no throw', async () => {
    const res = await PATCH(idReq('PATCH', { active: false }), props('not-a-uuid'))
    expect(res.status).toBe(404)
  })

  it('toggles active (the soft kill switch)', async () => {
    const res = await PATCH(idReq('PATCH', { active: false }), props(ROW_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.active).toBe(false)
  })

  it('invalid brand jsonb → 400', async () => {
    const res = await PATCH(idReq('PATCH', { brand: { rootRewriteTo: 'welcome' } }), props(ROW_ID))
    expect(res.status).toBe(400)
  })

  it('re-pointing the hostname at a reserved one → 400', async () => {
    const res = await PATCH(idReq('PATCH', { hostname: 'un1tdublin.com' }), props(ROW_ID))
    expect(res.status).toBe(400)
  })

  it('empty patch → 400', async () => {
    const res = await PATCH(idReq('PATCH', {}), props(ROW_ID))
    expect(res.status).toBe(400)
  })

  it('scoping to a location IN the org → 200, persisted', async () => {
    const res = await PATCH(idReq('PATCH', { location_id: LOC_ID }), props(ROW_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.location_id).toBe(LOC_ID)
  })

  it('scoping to a location in ANOTHER org → 400 (belongs-to-org validation)', async () => {
    const res = await PATCH(idReq('PATCH', { location_id: OTHER_LOC_ID }), props(ROW_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('does not belong to the selected organization')
  })

  it('clearing location_id back to null → 200 (whole-org)', async () => {
    await PATCH(idReq('PATCH', { location_id: LOC_ID }), props(ROW_ID))
    const res = await PATCH(idReq('PATCH', { location_id: null }), props(ROW_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.location_id ?? null).toBe(null)
  })

  it('changing the org that orphans the existing location → 400', async () => {
    // Row is first scoped to LOC_ID (in ORG_ID); moving the org to
    // OTHER_ORG_ID without also clearing/changing the location is refused.
    await PATCH(idReq('PATCH', { location_id: LOC_ID }), props(ROW_ID))
    const res = await PATCH(idReq('PATCH', { organization_id: OTHER_ORG_ID }), props(ROW_ID))
    expect(res.status).toBe(400)
  })
})

describe('DELETE — remove', () => {
  it('unknown id → 404', async () => {
    const res = await DELETE(idReq('DELETE'), props(MISSING_ID))
    expect(res.status).toBe(404)
  })

  it('removes the mapping', async () => {
    const res = await DELETE(idReq('DELETE'), props(ROW_ID))
    expect(res.status).toBe(200)
    const remaining = await db.from('tenant_domains').select('id')
    expect(remaining.data).toEqual([])
  })
})
