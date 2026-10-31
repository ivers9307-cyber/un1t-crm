// PAGES.1 — /api/chooser-settings/tile-image writes the cover URL into the
// studio page's chrome.chooser_image_url (it was landing_page_settings), under
// the same edit gate as /api/chooser-settings.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000001'
const LOC_A = 'aaaaaaaa-0000-0000-0000-0000000000aa'

const admin = {
  id: 'admin-a', isMaster: false, role: 'staff', rolesByLocation: {}, locations: [],
  orgAdminOrgIds: [ORG_A], organizationsById: { [ORG_A]: { id: ORG_A } }, activeOrganization: { id: ORG_A },
}

function makeDb({ locOrg = ORG_A, pages = [], updateResult = null } = {}) {
  const seen = { uploads: [], updates: [], pageReads: [] }
  const db = {
    from(table) {
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: locOrg ? { organization_id: locOrg } : null, error: null }) }) }) }
      }
      if (table === 'landing_pages') {
        const filters = []
        const rows = () => pages.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)))
        const b = {
          select: () => b,
          eq: (c, v) => { filters.push([c, v]); return b },
          in: (c, v) => { filters.push([c, v]); return b },
          then: (ok, bad) => { seen.pageReads.push([...filters]); return Promise.resolve({ data: rows(), error: null }).then(ok, bad) },
          update: (patch) => {
            const f = []
            const ub = {
              eq: (c, v) => { f.push([c, v]); return ub },
              select: () => ub,
              maybeSingle: async () => {
                seen.updates.push({ patch, filters: f })
                return updateResult || { data: { id: f[0][1] }, error: null }
              },
            }
            return ub
          },
        }
        return b
      }
      throw new Error(`unexpected table ${table}`)
    },
    storage: {
      from: () => ({
        list: async () => ({ data: [] }),
        remove: async () => ({}),
        upload: async (path) => { seen.uploads.push(path); return { error: null } },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn/${path}` } }),
      }),
    },
  }
  return { db, seen }
}

function upload(locationId = LOC_A) {
  const fd = new FormData()
  fd.set('location_id', locationId)
  fd.set('file', new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' }))
  return new Request('http://test.local/api/chooser-settings/tile-image', { method: 'POST', body: fd })
}

const studioPage = { id: 'page-a', organization_id: ORG_A, kind: 'studio', primary_location_id: LOC_A, chrome: { logo_url: 'https://cdn/logo.png' } }

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(admin) })

describe('POST /api/chooser-settings/tile-image', () => {
  it('merges chooser_image_url into the studio page chrome, scoped to the page and the org', async () => {
    const { db, seen } = makeDb({ pages: [studioPage] })
    createServerClient.mockReturnValue(db)
    const res = await POST(upload())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.url).toMatch(`https://cdn/landing-page/${LOC_A}/chooser.png?v=`)
    expect(seen.pageReads[0]).toEqual([['kind', 'studio'], ['organization_id', ORG_A], ['primary_location_id', [LOC_A]]])
    expect(seen.updates).toHaveLength(1)
    expect(seen.updates[0].filters).toEqual([['id', 'page-a'], ['organization_id', ORG_A]])
    expect(seen.updates[0].patch.chrome).toEqual({ logo_url: 'https://cdn/logo.png', chooser_image_url: body.data.url })
    expect(seen.updates[0].patch.updated_by).toBe('admin-a')
  })

  it('404s, uploading nothing, when the studio has no page in its org', async () => {
    const { db, seen } = makeDb({ pages: [{ ...studioPage, organization_id: ORG_B }] })
    createServerClient.mockReturnValue(db)
    const res = await POST(upload())
    expect(res.status).toBe(404)
    expect(seen.uploads).toEqual([])
    expect(seen.updates).toEqual([])
  })

  it('refuses a caller who is not an admin of the location\'s org (404 for a foreign org, nothing read or written)', async () => {
    getCurrentUser.mockResolvedValue({ ...admin, orgAdminOrgIds: [ORG_B], organizationsById: { [ORG_B]: { id: ORG_B } }, activeOrganization: { id: ORG_B } })
    const { db, seen } = makeDb({ pages: [studioPage] })
    createServerClient.mockReturnValue(db)
    const res = await POST(upload())
    expect(res.status).toBe(404)
    expect(seen.pageReads).toEqual([])
    expect(seen.uploads).toEqual([])
  })

  it('answers the failed write instead of success', async () => {
    const { db } = makeDb({ pages: [studioPage], updateResult: { data: null, error: { message: 'boom' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(upload())
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
  })
})
