// PAGES.1 — POST /api/landing-pages/[id]/publish: draft, live, coming soon,
// retired. Live needs a switched-on studio whose offer is ready
// (studioRowReadiness); retired needs a same-site redirect.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')
const { fakeDb, STILL_MANAGER, ORG_ADMIN, PAGE, STILL, HATCH, jsonRequest } = await import('../../../../../../tests/helpers/landing-pages-fixtures.js')

const publish = (id, body) => POST(jsonRequest(`/api/landing-pages/${id}/publish`, 'POST', body), { params: Promise.resolve({ id }) })
const stored = (db, id) => db.state.landing_pages.find((p) => p.id === id)
const rowsOf = (db, id) => db.state.landing_page_studios.filter((r) => r.page_id === id)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(ORG_ADMIN)
})

describe('POST /api/landing-pages/[id]/publish', () => {
  it('live is refused with not_ready when no enabled studio row is configured; granted when one is; retired needs redirect_to', async () => {
    stored(db, PAGE.trial).publish_state = 'draft'
    for (const r of rowsOf(db, PAGE.trial)) r.offer = {}
    const refused = await publish(PAGE.trial, { publish_state: 'live' })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      success: false,
      error: 'not_ready',
      studios: [
        { location_id: STILL, name: 'UN1T Stillorgan', reason: 'needs_plan' },
        { location_id: HATCH, name: 'UN1T Hatch Street', reason: 'needs_plan' },
      ],
    })
    expect(stored(db, PAGE.trial).publish_state).toBe('draft')

    rowsOf(db, PAGE.trial)[0].offer = { membership_id: 'm', plan_code: 'p', price_cents: 3900 }
    const granted = await publish(PAGE.trial, { publish_state: 'live' })
    expect(granted.status).toBe(200)
    expect(stored(db, PAGE.trial)).toMatchObject({ publish_state: 'live', redirect_to: null })
    expect(stored(db, PAGE.trial).chrome.was_live).toBe(true)

    const noRedirect = await publish(PAGE.trial, { publish_state: 'retired' })
    expect(noRedirect.status).toBe(400)
    expect(await noRedirect.json()).toMatchObject({ error: 'redirect_required' })

    const retired = await publish(PAGE.trial, { publish_state: 'retired', redirect_to: '/january?studio=stillorgan' })
    expect(retired.status).toBe(200)
    expect(stored(db, PAGE.trial)).toMatchObject({ publish_state: 'retired', redirect_to: '/january?studio=stillorgan' })
  })

  it('retired with redirect_to "//evil.com" is 400', async () => {
    for (const redirect_to of ['//evil.com', '/\\evil.com', 'https://evil.com']) {
      expect((await publish(PAGE.fiftyplus, { publish_state: 'retired', redirect_to })).status).toBe(400)
    }
    expect(stored(db, PAGE.fiftyplus).publish_state).toBe('live')
  })

  it('a disabled studio does not count, even when its offer is ready', async () => {
    stored(db, PAGE.fiftyplus).publish_state = 'draft'
    rowsOf(db, PAGE.fiftyplus)[0].enabled = false
    const res = await publish(PAGE.fiftyplus, { publish_state: 'live' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_ready', studios: [] })
  })

  it('a un1t.online studio with writes off is no_platform', async () => {
    stored(db, PAGE.trial).publish_state = 'draft'
    rowsOf(db, PAGE.trial)[0].enabled = false
    db.state.locations.find((l) => l.id === HATCH).settings = { un1t_online: { writes_enabled: false } }
    const res = await publish(PAGE.trial, { publish_state: 'live' })
    expect(await res.json()).toMatchObject({ error: 'not_ready', studios: [{ location_id: HATCH, reason: 'no_platform' }] })
  })

  it('draft and coming soon are always allowed; a page with no offer goes live with no studio check', async () => {
    for (const r of rowsOf(db, PAGE.trial)) r.offer = {}
    expect((await publish(PAGE.trial, { publish_state: 'coming_soon' })).status).toBe(200)
    expect((await publish(PAGE.trial, { publish_state: 'draft' })).status).toBe(200)
    expect(stored(db, PAGE.trial).publish_state).toBe('draft')
    expect((await publish(PAGE.hatch, { publish_state: 'live' })).status).toBe(200)
  })

  it('a studio page is never retired; a viewer who cannot edit is 403; outside the view is 404', async () => {
    const studio = await publish(PAGE.stillorgan, { publish_state: 'retired', redirect_to: '/trial' })
    expect(studio.status).toBe(400)
    expect(await studio.json()).toMatchObject({ error: 'studio_page' })

    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    expect((await publish(PAGE.trial, { publish_state: 'draft' })).status).toBe(403)
    expect((await publish(PAGE.corp, { publish_state: 'draft' })).status).toBe(404)
    expect(db.writes('landing_pages')).toEqual([])
  })
})
