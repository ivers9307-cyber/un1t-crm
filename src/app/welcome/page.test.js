// EDITGATE.1 — /welcome (the studio chooser) honours ?edit=1 only for a
// signed-in staff session, seeds the editor overlay from one of THAT
// session's studios, and hands it client-safe blocks. Anyone else gets the
// public chooser. (It used to hand the estate's most recently edited page,
// product ids and attribution included, to any visitor who appended ?edit=1.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({
  row: null,
  user: null,
  inArgs: null,
  overlayProps: null,
}))
vi.mock('next/navigation', () => ({ redirect: (u) => { throw new Error(`redirect ${u}`) } }))
vi.mock('next/headers', () => ({ headers: async () => new Map([['host', 'crm.un1tdublin.com']]) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => ({
      select: () => ({
        in: (col, ids) => { mocks.inArgs = [col, ids]; return { order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }) }) } },
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }) }),
      }),
    }),
  }),
}))
vi.mock('@/lib/welcome-front-page', () => ({
  loadFrontPage: async () => ({ headline: 'Choose your studio', intro: '', tiles: [{ path: 'stillorgan', name: 'Stillorgan', cover: null, disabled: false }] }),
  publicWelcomePathForLocation: async () => null,
}))
vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantLocationId: async () => null, resolveTenantOrgId: async () => 'org' }))
vi.mock('@/lib/default-site-name', () => ({ resolveGymSiteName: async () => 'UN1T Dublin' }))
vi.mock('@/lib/host-brand', () => ({ resolveLocationBrand: async () => ({ companyName: 'UN1T Stillorgan', locationName: 'Stillorgan', shortName: 'UN1T' }), resolveOrgChrome: async () => ({ companyName: 'UN1T Dublin', studios: [], legalName: '' }) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: async () => { if (mocks.user === 'throws') throw new Error('auth down'); return mocks.user }, getUserLocationIds: (u) => (u?.locations || []).map((l) => l.id) }))
vi.mock('@/components/landing-page/EditModeOverlay', () => ({ default: (p) => { mocks.overlayProps = p; return <div data-overlay="1" /> } }))

import WelcomePage from './page.js'

const SECRET = 'glofox-trial-mem-WITHHELD-1'
const page = (sp = {}) => WelcomePage({ searchParams: Promise.resolve(sp) })
const html = async (sp) => renderToStaticMarkup(await page(sp))

beforeEach(() => {
  mocks.user = null
  mocks.inArgs = null
  mocks.overlayProps = null
  mocks.row = { location_id: 'loc', logo_url: null, logo_alt: '', logo_width_px: 200, blocks: [{ id: 'h', type: 'hero', headline: 'Hi' }, { id: 'cf', type: 'class_funnel', heading: 'Free', trial_membership_id: SECRET }], locations: { organization_id: 'org' } }
})

describe('/welcome ?edit=1 (EDITGATE.1)', () => {
  it('an anonymous ?edit=1 request renders the public chooser without the seed', async () => {
    const out = await html({ edit: '1' })
    expect(mocks.overlayProps).toBeNull()
    expect(out).not.toContain('data-overlay')
    expect(out).toContain('Choose your studio')
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('trial_membership_id')
    expect(mocks.inArgs).toBeNull()
  })

  it('a failed session read renders the public chooser', async () => {
    mocks.user = 'throws'
    const out = await html({ edit: '1' })
    expect(mocks.overlayProps).toBeNull()
    expect(out).toContain('Choose your studio')
  })

  it('a staff session with no studio renders the public chooser', async () => {
    mocks.user = { id: 'u0', locations: [] }
    const out = await html({ edit: '1' })
    expect(mocks.overlayProps).toBeNull()
    expect(out).toContain('Choose your studio')
  })

  it("a staff session gets the overlay, seeded from one of ITS studios' pages, client-safe", async () => {
    mocks.user = { id: 'u1', locations: [{ id: 'loc' }, { id: 'loc2' }] }
    const out = await html({ edit: '1' })
    expect(out).toContain('data-overlay')
    expect(mocks.inArgs).toEqual(['location_id', ['loc', 'loc2']])
    const seeded = JSON.stringify(mocks.overlayProps.initialBlocks)
    expect(seeded).toContain('"id":"cf"')
    expect(seeded).not.toContain(SECRET)
    expect(seeded).not.toContain('trial_membership_id')
    expect(mocks.overlayProps.initialLogoAlt).toBe('UN1T Stillorgan')
  })

  it('a staff session whose studios have no page yet is seeded with the defaults', async () => {
    mocks.user = { id: 'u1', locations: [{ id: 'new-loc' }] }
    mocks.row = null
    await html({ edit: '1' })
    expect(mocks.overlayProps.initialBlocks.map((b) => b.type)).toEqual(['hero', 'booking', 'pillars', 'stats', 'testimonial'])
  })

  it('without ?edit=1 nothing asks for a session', async () => {
    mocks.user = 'throws'
    const out = await html({})
    expect(out).toContain('Choose your studio')
  })
})
