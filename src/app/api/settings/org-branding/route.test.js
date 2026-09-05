// HYGIENE-PII.1 — PUT /api/settings/org-branding is the organisation-level
// twin of /api/settings/branding, and carried the same hole: `logo_url` and
// `favicon_url` validated with Zod 4's scheme-agnostic `.url()`, so a
// `javascript:` or `data:` URL was accepted, stored on org_settings and
// inherited by every location without its own branding (getLocationBranding)
// into `<img src>` / `<link rel=icon>`. The schema now takes `httpUrl`.
//
// This is the route's first test file, so it pins only the scheme contract
// plus the happy path it must not disturb. @/lib/auth is the REAL module with
// only getCurrentUser mocked, as in the sibling branding test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG = 'c0000000-0000-0000-0000-000000000001'
const LOC = 'a0000000-0000-0000-0000-000000000001'

// A master targets any org (resolveOrgId short-circuits on role), so the
// gate is out of the way and the schema is the only thing between the body
// and the upsert. `role: 'master'` is what the route's own 403 reads.
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master',
  locations: [{ id: LOC, organization_id: ORG }], rolesByLocation: {},
  activeLocation: { id: LOC }, activeOrganization: { id: ORG },
}

function makeDb() {
  const upserts = []
  return {
    upserts,
    from(table) {
      if (table !== 'org_settings') throw new Error(`unexpected db.from('${table}') in org-branding PUT test`)
      const b = {
        upsert: (payload, opts) => { upserts.push({ payload, opts }); return b },
        select: () => b,
        single: () => Promise.resolve({ data: { organization_id: ORG }, error: null }),
      }
      return b
    },
  }
}

const put = (body) => new Request('http://localhost/api/settings/org-branding', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('PUT /api/settings/org-branding — logo_url / favicon_url are http(s) only', () => {
  const REFUSED = [
    ['logo_url', 'javascript:alert(1)'],
    ['favicon_url', 'javascript:alert(1)'],
    ['logo_url', 'data:text/html,<script>alert(1)</script>'],
    ['favicon_url', 'data:image/svg+xml;base64,PHN2Zy8+'],
  ]
  for (const [field, value] of REFUSED) {
    it(`400s ${field} = ${value.split(':')[0]}: without writing`, async () => {
      const res = await PUT(put({ organization_id: ORG, [field]: value }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toBe('Invalid request body')
      expect(body.issues).toEqual([{ path: field, message: 'Must be an http(s) URL' }])
      expect(db.upserts).toEqual([])
    })
  }

  it('https and http URLs are stored exactly as before, keyed on the org', async () => {
    const res = await PUT(put({ organization_id: ORG, logo_url: 'https://cdn.example/logo.png', favicon_url: 'http://cdn.example/fav.ico', company_name: 'Repset' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { organization_id: ORG } })
    const { payload, opts } = db.upserts[0]
    expect(payload).toMatchObject({
      organization_id: ORG,
      logo_url: 'https://cdn.example/logo.png',
      favicon_url: 'http://cdn.example/fav.ico',
      company_name: 'Repset',
      updated_by: 'u5',
    })
    expect(opts).toEqual({ onConflict: 'organization_id' })
  })

  it('an explicit null still clears the field — the scheme check never sees a null', async () => {
    const res = await PUT(put({ organization_id: ORG, logo_url: null }))
    expect(res.status).toBe(200)
    expect(db.upserts[0].payload.logo_url).toBeNull()
  })
})
