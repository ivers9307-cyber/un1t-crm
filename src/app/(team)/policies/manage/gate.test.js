// C141 ORGROLE.2 — managing policies (the /policies/manage tree, the
// "Manage policies" link on /policies, and the publish route behind it) is
// organisation-level: C18's rule, organisation admins only (a master or an
// org_admin grant on the active organisation). An owner at a studio keeps
// /policies itself (reading), not the manage surfaces.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/policies', () => ({
  currentVersionOpenCounts: vi.fn(async () => ({ viewerCount: new Map(), activeStaffCount: 0 })),
  listPoliciesWithStatus: vi.fn(async () => []),
  listVersions: vi.fn(async () => []),
  listVersionViewers: vi.fn(async () => ({ viewers: [], notOpened: [], all_views: [] })),
  getVersion: vi.fn(async () => null),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }) => <a href={typeof href === 'string' ? href : ''}>{children}</a>,
}))

import ManagePage from './page.js'
import ManageDetailPage from './[slug]/page.js'
import ManageVersionPage from './[slug]/versions/[versionNumber]/page.js'
import PoliciesPage from '../page.js'
import { POST as publishVersion } from '@/app/api/admin/policies/[slug]/versions/route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG = 'org-a'
const owner = (orgAdminOrgIds = []) => ({
  id: 'u1', role: 'owner', isMaster: false,
  activeOrganization: { id: ORG }, orgAdminOrgIds,
})

function db() {
  const b = {}
  for (const m of ['select', 'eq', 'order', 'in', 'is']) b[m] = () => b
  b.maybeSingle = () => Promise.resolve({ data: null, error: null })
  b.then = (resolve) => Promise.resolve({ data: [], error: null }).then(resolve)
  return { from: vi.fn(() => b), rpc: vi.fn() }
}

const params = { params: Promise.resolve({ slug: 'conduct', versionNumber: '1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createServerClient).mockReturnValue(db())
})

describe('/policies/manage tree — organisation admins only (C141)', () => {
  for (const [name, render] of [
    ['/policies/manage', () => ManagePage()],
    ['/policies/manage/[slug]', () => ManageDetailPage(params)],
    ['/policies/manage/[slug]/versions/[n]', () => ManageVersionPage(params)],
  ]) {
    it(`${name}: an owner without an org_admin grant is sent home`, async () => {
      vi.mocked(getCurrentUser).mockResolvedValue(owner([]))
      await expect(render()).rejects.toThrow('NEXT_REDIRECT:/')
    })

    it(`${name}: an org admin of a DIFFERENT organisation is sent home`, async () => {
      vi.mocked(getCurrentUser).mockResolvedValue(owner(['org-b']))
      await expect(render()).rejects.toThrow('NEXT_REDIRECT:/')
    })

    it(`${name}: an org admin of the active organisation gets past the gate`, async () => {
      vi.mocked(getCurrentUser).mockResolvedValue(owner([ORG]))
      // Past the gate the page reads policies (or 404s on the empty fixture);
      // never the home redirect.
      await render().then(
        () => {},
        (err) => expect(String(err?.message)).not.toBe('NEXT_REDIRECT:/'),
      )
    })
  }
})

describe('/policies — the "Manage policies" link (C141)', () => {
  it('is hidden from an owner without an org_admin grant', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(owner([]))
    const html = renderToStaticMarkup(await PoliciesPage())
    expect(html).not.toContain('/policies/manage')
  })

  it('is shown to an org admin of the active organisation', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(owner([ORG]))
    const html = renderToStaticMarkup(await PoliciesPage())
    expect(html).toContain('/policies/manage')
  })
})

describe('POST /api/admin/policies/[slug]/versions (C141)', () => {
  const req = () => new Request('http://x/api/admin/policies/conduct/versions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })

  it('refuses an owner without an org_admin grant (403) before reading anything', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(owner([]))
    const res = await publishVersion(req(), params)
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('lets an org admin of the active organisation through to validation (400 on an empty body)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(owner([ORG]))
    const res = await publishVersion(req(), params)
    expect(res.status).toBe(400)
  })
})
