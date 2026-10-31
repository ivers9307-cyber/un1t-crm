// /welcome (the studio chooser). PAGES.1: the tiles link to the studio page's
// canonical /<slug> (the /welcome/<slug> redirect stays for old links), a
// location-scoped tenant domain lands on /<slug> too, and `?edit=1` is an
// ordinary request: the edit-mode overlay branch (EDITGATE.1) went with the
// legacy landing-page form, so nothing reads a session or a studio page for it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({
  scopedLocationId: null,
  landingPath: null,
  authReads: 0,
  tables: [],
}))
vi.mock('next/navigation', () => ({ redirect: (u) => { throw new Error(`redirect ${u}`) } }))
vi.mock('next/headers', () => ({ headers: async () => new Map([['host', 'crm.un1tdublin.com']]) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: (t) => { mocks.tables.push(t); throw new Error('the page reads through the loaders only') } }) }))
vi.mock('@/lib/welcome-front-page', () => ({
  loadFrontPage: async () => ({
    headline: 'Choose your studio',
    intro: '',
    tiles: [
      { path: 'stillorgan', name: 'Stillorgan', cta: 'Enter', cover: null, disabled: false },
      { path: 'hatch-street', name: 'Hatch Street', cta: 'Enter', cover: null, disabled: true },
    ],
  }),
  publicWelcomePathForLocation: async () => mocks.landingPath,
}))
vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantLocationId: async () => mocks.scopedLocationId, resolveTenantOrgId: async () => 'org' }))
vi.mock('@/lib/default-site-name', () => ({ resolveGymSiteName: async () => 'UN1T Dublin' }))
// The edit-mode branch read a session; a page that still did would trip this.
vi.mock('@/lib/auth', () => ({ getCurrentUser: async () => { mocks.authReads += 1; return null } }))

import WelcomePage from './page.js'

const html = async (sp = {}) => renderToStaticMarkup(await WelcomePage({ searchParams: Promise.resolve(sp) }))

beforeEach(() => {
  mocks.scopedLocationId = null
  mocks.landingPath = null
  mocks.authReads = 0
  mocks.tables = []
})

describe('/welcome chooser (PAGES.1)', () => {
  it('links an active tile to the studio page at /<slug>, not /welcome/<slug>', async () => {
    const out = await html()
    expect(out).toContain('href="/stillorgan"')
    expect(out).not.toContain('/welcome/stillorgan')
    expect(out).toContain('Choose your studio')
  })

  it('a coming-soon tile is not a link', async () => {
    const out = await html()
    expect(out).not.toContain('href="/hatch-street"')
    expect(out).toContain('Coming soon')
  })

  it('?edit=1 is an ordinary request: the chooser renders, no session or studio page is read', async () => {
    const out = await html({ edit: '1' })
    expect(out).toContain('Choose your studio')
    expect(out).toContain('href="/stillorgan"')
    expect(out).not.toContain('data-overlay')
    expect(mocks.authReads).toBe(0)
    expect(mocks.tables).toEqual([])
  })

  it('a location-scoped tenant domain redirects to its studio page path', async () => {
    mocks.scopedLocationId = 'loc-1'
    mocks.landingPath = '/stillorgan'
    await expect(html()).rejects.toThrow('redirect /stillorgan')
  })

  it('a scoped domain whose studio has no page renders the chooser', async () => {
    mocks.scopedLocationId = 'loc-1'
    mocks.landingPath = null
    expect(await html()).toContain('Choose your studio')
  })
})
